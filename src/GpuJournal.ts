import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { formatDuration } from './GpuLock';
import type { JobPriority } from './GpuLock';

/**
 * One GPU lease, written when it is released: who held the GPU, from when to when, and how long
 * it waited for it. A client that dies holding the lease writes nothing.
 */
export interface GpuJournalEntry {
  readonly id: string;
  /** Holder text, e.g. `guichet: image`; the project is what comes before the first `:`. */
  readonly holder: string;
  readonly pid: number;
  readonly priority: JobPriority;
  readonly launcher?: string;
  /** Epoch ms. */
  readonly requestedAt: number;
  readonly acquiredAt: number;
  readonly releasedAt: number;
  /** The lease had been broken by another client (`stack gpu release --force`) before its release. */
  readonly broken?: true;
}

/** Per project: leases, time holding the GPU, time waiting for it. */
export interface GpuJournalLine {
  readonly project: string;
  readonly leases: number;
  readonly heldMs: number;
  readonly waitedMs: number;
}

/** `$XDG_STATE_HOME/llm-stack/gpu-journal`: unlike the lock, it must survive a reboot. */
export function defaultGpuJournalDir(): string {
  const stateHome = process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state');
  return path.join(stateHome, 'llm-stack', 'gpu-journal');
}

/** Appends to `<dir>/YYYY-MM.jsonl` (local month of the release). Never throws: the journal must not break a lease. */
export function appendGpuJournal(dir: string, entry: GpuJournalEntry): void {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, `${localMonth(entry.releasedAt)}.jsonl`), `${JSON.stringify(entry)}\n`);
  } catch {
    // Disk full or read-only: the lease matters more than its trace.
  }
}

/** Leases held at some point in [since, until), oldest first. Skips unreadable lines. */
export function readGpuJournal(dir: string, since: number, until = Infinity): GpuJournalEntry[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name));
  } catch {
    return [];
  }
  // A lease released in a month started at most in the previous one, in practice.
  const first = localMonth(since - 31 * 24 * 3600_000);
  const entries: GpuJournalEntry[] = [];
  for (const file of files.filter((name) => name.slice(0, 7) >= first).sort()) {
    for (const line of readFileSync(path.join(dir, file), 'utf-8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const entry = JSON.parse(line) as GpuJournalEntry;
        if (entry.releasedAt > since && entry.acquiredAt < until) entries.push(entry);
      } catch {
        // A line cut by a crash.
      }
    }
  }
  return entries.sort((a, b) => a.acquiredAt - b.acquiredAt);
}

/** `guichet: image` → `guichet`. */
export function holderProject(holder: string): string {
  const colon = holder.indexOf(':');
  return (colon < 0 ? holder : holder.slice(0, colon)).trim() || '?';
}

/** Per project, the most GPU time first. */
export function summarizeGpuJournal(entries: GpuJournalEntry[]): GpuJournalLine[] {
  const lines = new Map<string, { project: string; leases: number; heldMs: number; waitedMs: number }>();
  for (const entry of entries) {
    const project = holderProject(entry.holder);
    const line = lines.get(project) ?? { project, leases: 0, heldMs: 0, waitedMs: 0 };
    line.leases++;
    line.heldMs += Math.max(0, entry.releasedAt - entry.acquiredAt);
    line.waitedMs += Math.max(0, entry.acquiredAt - entry.requestedAt);
    lines.set(project, line);
  }
  return [...lines.values()].sort((a, b) => b.heldMs - a.heldMs);
}

function localMonth(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * What `stack gpu history` prints: one line per project, then each lease when `detail` is set
 * (`stack gpu history <date>`). Times are local.
 */
export function formatGpuHistory(entries: GpuJournalEntry[], title: string, detail = false): string {
  if (entries.length === 0) {
    return `${title}: no GPU lease.`;
  }
  const lines = summarizeGpuJournal(entries);
  const held = lines.reduce((sum, line) => sum + line.heldMs, 0);
  const rows = [['project', 'leases', 'held', 'waited'], ...lines.map((l) => [l.project, String(l.leases), formatDuration(l.heldMs), formatDuration(l.waitedMs)])];
  const out = [`${title}: ${entries.length} leases, GPU held ${formatDuration(held)}`, '', ...columns(rows)];
  if (detail) {
    out.push('');
    for (const entry of entries) {
      const waited = entry.acquiredAt - entry.requestedAt;
      out.push(`${clock(entry.acquiredAt)}-${clock(entry.releasedAt)}  ${formatDuration(entry.releasedAt - entry.acquiredAt).padStart(6)}  P${entry.priority}  ${entry.holder}`
        + `${waited >= 1000 ? ` (waited ${formatDuration(waited)})` : ''}${entry.broken ? ' (broken)' : ''}`);
    }
  }
  return out.join('\n');
}

function clock(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** First column left-aligned, the others right-aligned. */
function columns(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
  return rows.map((row) => row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!))).join('  ').trimEnd());
}
