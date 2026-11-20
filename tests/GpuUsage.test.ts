import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GpuJournalEntry } from '../src/GpuJournal';
import { appendGpuSample, formatGpuUsage, gpuSampleDays, NO_LEASE, readGpuSamples, summarizeGpuUsage } from '../src/GpuUsage';
import type { GpuSample } from '../src/GpuUsage';

const at = (h: number, m = 0, s = 0) => new Date(2026, 10, 20, h, m, s).getTime();
const sample = (t: number, powerW: number, utilPct = 0): GpuSample => ({ at: t, powerW, utilPct, memMib: 12_288, tempC: 40 });
const lease = (holder: string, from: number, to: number): GpuJournalEntry =>
  ({ id: `${holder}${from}`, holder, pid: 1, priority: 2, requestedAt: from, acquiredAt: from, releasedAt: to });

/** One sample every 10 s from `from` for `count` samples. */
function series(from: number, count: number, powerW: (i: number) => number): GpuSample[] {
  return Array.from({ length: count }, (_, i) => sample(from + i * 10_000, powerW(i), powerW(i) > 100 ? 95 : 0));
}

describe('GpuUsage', () => {
  test('writes one CSV per local day and reads it back', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'llm-stack-ts-samples-'));
    appendGpuSample(dir, sample(at(23, 59, 50), 8.5));
    appendGpuSample(dir, sample(at(23, 59, 50) + 20_000, 150));
    expect(gpuSampleDays(dir)).toEqual(['2026-11-20', '2026-11-21']);
    expect(readGpuSamples(dir, ['2026-11-20', '2026-11-21', '2026-11-22']).map((s) => [s.at, s.powerW])).toEqual([
      [at(23, 59, 50), 8.5],
      [at(23, 59, 50) + 20_000, 150],
    ]);
  });

  test('sums the energy per hour and per project holding the lease', () => {
    // 12:00-12:10 at 150 W (guichet holds the lease 12:00-12:05, chat 12:05-12:10), then 8 W.
    const samples = series(at(12), 121, (i) => (i < 60 ? 150 : 8));
    const usage = summarizeGpuUsage(samples, [lease('guichet: image', at(12), at(12, 5)), lease('chat: start qwen', at(12, 5), at(12, 10))], 'hour');

    expect(usage.totalWh).toBeCloseTo(150 * 600 / 3600 + 8 * 600 / 3600);
    expect(usage.rows.map((r) => [r.key, Math.round(r.wh * 10) / 10, r.busySeconds, r.peakW])).toEqual([['12h', 26.3, 600, 150]]);
    expect(usage.projects.map((p) => [p.project, p.leases, p.seconds, Math.round(p.wh * 10) / 10])).toEqual([
      ['guichet', 1, 300, 12.5],
      ['chat', 1, 300, 12.5],
      [NO_LEASE, 0, 600, 1.3],
    ]);
    const text = formatGpuUsage(usage, 'hour');
    expect(text).toContain('guichet');
    expect(text).toContain('total  26.3');
    expect(text.split('\n')[0]).toBe('hour     Wh  mean W  peak W  busy  busy %  VRAM max');
  });

  test('a gap in the samples counts 30 s at most', () => {
    const usage = summarizeGpuUsage([sample(at(1), 100), sample(at(2), 100)], [], 'day');
    expect(usage.totalWh).toBeCloseTo(100 * 30 / 3600);
    expect(usage.rows[0]!.key).toBe('2026-11-20');
    expect(formatGpuUsage(summarizeGpuUsage([], [], 'day'), 'day')).toBe('No GPU sample (run `stack gpu sample`).');
  });
});
