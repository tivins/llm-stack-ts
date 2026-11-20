import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { holderProject } from './GpuJournal';
import type { GpuJournalEntry } from './GpuJournal';
import { sleep } from './sleep';

/** One reading of the GPU: `stack gpu sample` writes one every few seconds. */
export interface GpuSample {
  /** Epoch ms. */
  readonly at: number;
  readonly powerW: number;
  readonly utilPct: number;
  readonly memMib: number;
  readonly tempC: number;
}

/** Energy and load of one period (a day or an hour). */
export interface GpuUsageRow {
  readonly key: string;
  readonly wh: number;
  /** Seconds covered by samples. */
  readonly seconds: number;
  /** Seconds with the GPU above `BUSY_PCT` of use. */
  readonly busySeconds: number;
  readonly peakW: number;
  readonly vramMaxMib: number;
}

/** Energy spent while a project held the GPU lease; `(no lease)` is the rest. */
export interface GpuUsageProject {
  readonly project: string;
  readonly leases: number;
  readonly seconds: number;
  readonly wh: number;
}

export interface GpuUsage {
  readonly rows: GpuUsageRow[];
  readonly projects: GpuUsageProject[];
  readonly totalWh: number;
}

export const NO_LEASE = '(no lease)';
/** A sample counts until the next one, at most this long: beyond, the sampler was stopped. */
export const MAX_SAMPLE_GAP_MS = 30_000;
const BUSY_PCT = 10;
const QUERY = 'power.draw,utilization.gpu,memory.used,temperature.gpu';

/** `$XDG_STATE_HOME/llm-stack/gpu-samples`: one CSV per local day. */
export function defaultGpuSamplesDir(): string {
  const stateHome = process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state');
  return path.join(stateHome, 'llm-stack', 'gpu-samples');
}

/** Reads the first GPU with `nvidia-smi`; null when it fails (no driver, GPU lost). */
export async function readGpuSample(): Promise<GpuSample | null> {
  try {
    const proc = Bun.spawn(['nvidia-smi', `--query-gpu=${QUERY}`, '--format=csv,noheader,nounits'], { stdout: 'pipe', stderr: 'ignore' });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    const [powerW, utilPct, memMib, tempC] = (out.split('\n')[0] ?? '').split(',').map((v) => Number(v.trim()));
    if (!Number.isFinite(powerW)) return null;
    return { at: Date.now(), powerW: powerW!, utilPct: utilPct ?? 0, memMib: memMib ?? 0, tempC: tempC ?? 0 };
  } catch {
    return null;
  }
}

/** Appends to `<dir>/YYYY-MM-DD.csv`: `epoch_s,power_w,util_pct,mem_mib,temp_c`. */
export function appendGpuSample(dir: string, sample: GpuSample): void {
  mkdirSync(dir, { recursive: true });
  const line = [Math.round(sample.at / 1000), sample.powerW, sample.utilPct, sample.memMib, sample.tempC].join(',');
  appendFileSync(path.join(dir, `${localDay(sample.at)}.csv`), `${line}\n`);
}

/** `stack gpu sample`: reads the GPU every `intervalMs` until `signal` aborts. Skips failed readings. */
export async function runGpuSampler(dir: string, intervalMs: number, signal?: AbortSignal): Promise<void> {
  while (!signal?.aborted) {
    const sample = await readGpuSample();
    if (sample !== null) {
      try {
        appendGpuSample(dir, sample);
      } catch {
        // Disk full: try again next time.
      }
    }
    try {
      await sleep(intervalMs, signal);
    } catch {
      return;
    }
  }
}

/** The local days (YYYY-MM-DD) that have samples, oldest first. */
export function gpuSampleDays(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f)).map((f) => f.slice(0, 10)).sort();
}

/** The samples of these local days, oldest first. Skips unreadable lines. */
export function readGpuSamples(dir: string, days: string[]): GpuSample[] {
  const samples: GpuSample[] = [];
  for (const day of days) {
    const file = path.join(dir, `${day}.csv`);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
      const [at, powerW, utilPct, memMib, tempC] = line.split(',').map(Number);
      if (at && Number.isFinite(powerW)) samples.push({ at: at * 1000, powerW: powerW!, utilPct: utilPct ?? 0, memMib: memMib ?? 0, tempC: tempC ?? 0 });
    }
  }
  return samples.sort((a, b) => a.at - b.at);
}

/**
 * Energy per period (`by`: local day or hour), and per project: each sample counts, until the
 * next one (at most `MAX_SAMPLE_GAP_MS`), for the project holding the GPU lease at its time.
 */
export function summarizeGpuUsage(samples: GpuSample[], leases: GpuJournalEntry[], by: 'day' | 'hour'): GpuUsage {
  const sorted = [...leases].sort((a, b) => a.acquiredAt - b.acquiredAt);
  const rows = new Map<string, { key: string; wh: number; seconds: number; busySeconds: number; peakW: number; vramMaxMib: number }>();
  const projects = new Map<string, { project: string; ids: Set<string>; seconds: number; wh: number }>();
  let totalWh = 0;
  let first = 0;
  for (let i = 0; i + 1 < samples.length; i++) {
    const sample = samples[i]!;
    const seconds = Math.min(MAX_SAMPLE_GAP_MS, Math.max(0, samples[i + 1]!.at - sample.at)) / 1000;
    const wh = (sample.powerW * seconds) / 3600;
    totalWh += wh;

    const key = by === 'day' ? localDay(sample.at) : `${pad(new Date(sample.at).getHours())}h`;
    const row = rows.get(key) ?? { key, wh: 0, seconds: 0, busySeconds: 0, peakW: 0, vramMaxMib: 0 };
    row.wh += wh;
    row.seconds += seconds;
    if (sample.utilPct > BUSY_PCT) row.busySeconds += seconds;
    row.peakW = Math.max(row.peakW, sample.powerW);
    row.vramMaxMib = Math.max(row.vramMaxMib, sample.memMib);
    rows.set(key, row);

    while (first < sorted.length && sorted[first]!.releasedAt <= sample.at) first++;
    let lease: GpuJournalEntry | undefined;
    for (let j = first; j < sorted.length && sorted[j]!.acquiredAt <= sample.at; j++) {
      if (sample.at < sorted[j]!.releasedAt) lease = sorted[j];
    }
    const project = lease ? holderProject(lease.holder) : NO_LEASE;
    const entry = projects.get(project) ?? { project, ids: new Set<string>(), seconds: 0, wh: 0 };
    entry.wh += wh;
    entry.seconds += seconds;
    if (lease) entry.ids.add(lease.id);
    projects.set(project, entry);
  }
  return {
    rows: [...rows.values()],
    projects: [...projects.values()].map(({ ids, ...p }) => ({ ...p, leases: ids.size })).sort((a, b) => b.wh - a.wh),
    totalWh,
  };
}

/** What `stack gpu usage` prints. */
export function formatGpuUsage(usage: GpuUsage, by: 'day' | 'hour'): string {
  if (usage.rows.length === 0) return 'No GPU sample (run `stack gpu sample`).';
  const rows = usage.rows.map((r) => [
    r.key, r.wh.toFixed(1), meanW(r.wh, r.seconds), r.peakW.toFixed(0), minutes(r.busySeconds),
    `${percent(r.busySeconds, r.seconds)}%`, `${(r.vramMaxMib / 1024).toFixed(1)}GB`,
  ]);
  const busy = usage.rows.reduce((sum, r) => sum + r.busySeconds, 0);
  rows.push(['total', usage.totalWh.toFixed(1), '', '', minutes(busy), '', '']);
  const projects = usage.projects.map((p) => [
    p.project, p.leases ? String(p.leases) : '', minutes(p.seconds), p.wh.toFixed(1), `${percent(p.wh, usage.totalWh)}%`, meanW(p.wh, p.seconds),
  ]);
  return [
    ...columns([[by, 'Wh', 'mean W', 'peak W', 'busy', 'busy %', 'VRAM max'], ...rows]),
    '',
    'Per project (while it held the GPU lease):',
    ...columns([['project', 'leases', 'time', 'Wh', 'share', 'mean W'], ...projects]),
    '',
    'GPU only (neither CPU nor power supply). Busy: above 10% of use.',
  ].join('\n');
}

const pad = (n: number) => String(n).padStart(2, '0');
const meanW = (wh: number, seconds: number) => (seconds ? (wh * 3600) / seconds : 0).toFixed(1);
const percent = (part: number, whole: number) => (whole ? Math.round((100 * part) / whole) : 0);

function minutes(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${pad(m % 60)}m`;
}

function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** First column left-aligned, the others right-aligned. */
function columns(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
  return rows.map((row) => row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!))).join('  ').trimEnd());
}
