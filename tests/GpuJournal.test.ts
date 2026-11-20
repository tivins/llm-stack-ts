import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendGpuJournal, formatGpuHistory, holderProject, readGpuJournal, summarizeGpuJournal } from '../src/GpuJournal';
import type { GpuJournalEntry } from '../src/GpuJournal';
import { GpuLock } from '../src/GpuLock';

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'llm-stack-ts-journal-'));
const at = (h: number, m = 0) => new Date(2026, 10, 20, h, m).getTime();
const entry = (holder: string, from: number, to: number, waited = 0): GpuJournalEntry =>
  ({ id: `${from}`, holder, pid: 1, priority: 2, requestedAt: from - waited, acquiredAt: from, releasedAt: to });

describe('GpuJournal', () => {
  test('a lock with a journal writes each released lease, broken ones marked', async () => {
    const journal = tempDir();
    const lock = new GpuLock(tempDir(), { pollMs: 10, journalDir: journal });

    const lease = await lock.acquire({ holder: 'guichet: image', priority: 2, launcher: 'comfyui', idleMs: 0 });
    lease.release();
    lease.release();
    const broken = await lock.acquire({ holder: 'chat: start qwen' });
    lock.forceRelease();
    broken.release();

    const entries = readGpuJournal(journal, 0);
    expect(entries.map((e) => [e.holder, e.priority, e.launcher, e.pid, e.broken])).toEqual([
      ['guichet: image', 2, 'comfyui', process.pid, undefined],
      ['chat: start qwen', 1, undefined, process.pid, true],
    ]);
    expect(entries[0]!.requestedAt).toBeLessThanOrEqual(entries[0]!.acquiredAt);
    expect(entries[0]!.acquiredAt).toBeLessThanOrEqual(entries[0]!.releasedAt);
    expect(readdirSync(journal)).toHaveLength(1);
  });

  test('a lock without a journal writes nothing', async () => {
    const dir = tempDir();
    const lock = new GpuLock(dir, { pollMs: 10 });
    (await lock.acquire({ holder: 'x' })).release();
    expect(readdirSync(dir).filter((name) => name.endsWith('.jsonl'))).toEqual([]);
  });

  test('reads the leases overlapping a range, across months, skipping broken lines', () => {
    const dir = tempDir();
    const october = entry('a', new Date(2026, 9, 31, 23, 50).getTime(), new Date(2026, 9, 31, 23, 59).getTime());
    const across = entry('b', new Date(2026, 9, 31, 23, 59).getTime(), at(0, 5));
    const later = entry('c', at(12), at(12, 1));
    for (const e of [october, across, later]) appendGpuJournal(dir, e);
    appendFileSync(path.join(dir, '2026-11.jsonl'), '{"cut');

    expect(readGpuJournal(dir, at(0), at(1)).map((e) => e.holder)).toEqual(['b']);
    expect(readGpuJournal(dir, 0, at(23)).map((e) => e.holder)).toEqual(['a', 'b', 'c']);
    expect(readGpuJournal(path.join(dir, 'none'), 0)).toEqual([]);
  });

  test('sums per project, the most GPU time first', () => {
    expect(holderProject('guichet: image')).toBe('guichet');
    expect(holderProject('stack')).toBe('stack');
    const entries = [entry('chat: start qwen', at(10), at(10, 1), 2000), entry('guichet: image', at(11), at(11, 10)), entry('guichet: song', at(12), at(12, 5), 30_000)];
    expect(summarizeGpuJournal(entries)).toEqual([
      { project: 'guichet', leases: 2, heldMs: 15 * 60_000, waitedMs: 30_000 },
      { project: 'chat', leases: 1, heldMs: 60_000, waitedMs: 2000 },
    ]);
    const text = formatGpuHistory(entries, '2026-11-20', true);
    expect(text).toContain('2026-11-20: 3 leases, GPU held 16m00s');
    expect(text).toContain('12:00:00-12:05:00   5m00s  P2  guichet: song (waited 30s)');
    expect(formatGpuHistory([], 'Last 7 days')).toBe('Last 7 days: no GPU lease.');
  });
});
