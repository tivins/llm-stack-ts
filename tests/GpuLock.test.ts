import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GpuLock } from '../src/GpuLock';
import type { LeaseInfo } from '../src/GpuLock';

const CLIENT = path.join(import.meta.dir, 'fixtures/lease-client.ts');
const children: ReturnType<typeof Bun.spawn>[] = [];

function newLock(): GpuLock {
  return new GpuLock(mkdtempSync(path.join(tmpdir(), 'llm-stack-ts-lock-')), { pollMs: 10 });
}

/** Resolves to 'pending' if `promise` has not settled within `ms`. */
async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  return Promise.race([promise, Bun.sleep(ms).then(() => 'pending' as const)]);
}

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL');
  }
});

describe('GpuLock', () => {
  test('grants a free GPU at once and frees it on release', async () => {
    const lock = newLock();

    const lease = await lock.acquire({ holder: 'first' });

    expect(lease.held).toBe(true);
    expect(lock.status().holder?.holder).toBe('first');
    expect(lock.status().holder?.acquiredAt).toBeInstanceOf(Date);
    lease.release();
    expect(lease.held).toBe(false);
    expect(lock.status()).toEqual({ holder: null, waiting: [] });
  });

  test('waiters get the GPU in order of arrival, and are told who holds it', async () => {
    const lock = newLock();
    const first = await lock.acquire({ holder: 'first' });
    const seen: LeaseInfo[] = [];
    const second = lock.acquire({ holder: 'second', onWait: (holder) => seen.push(holder) });
    await Bun.sleep(30);
    const third = lock.acquire({ holder: 'third' });
    await Bun.sleep(30);

    expect(lock.status().waiting.map((lease) => lease.holder)).toEqual(['second', 'third']);
    expect(seen.map((lease) => lease.holder)).toEqual(['first']);

    first.release();
    const secondLease = await second;
    expect(await settledWithin(third, 50)).toBe('pending');

    secondLease.release();
    expect((await third).holder).toBe('third');
  });

  test('withLease releases on error, and a nested withLease reuses the lease', async () => {
    const lock = newLock();

    await expect(
      lock.withLease({ holder: 'outer' }, async (outer) => {
        expect(lock.currentLease()).toBe(outer);
        const inner = await lock.withLease({ holder: 'inner' }, async (lease) => lease);
        expect(inner).toBe(outer);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(lock.currentLease()).toBeUndefined();
    expect(lock.status().holder).toBeNull();
  });

  test('an aborted wait leaves the queue', async () => {
    const lock = newLock();
    const first = await lock.acquire({ holder: 'first' });
    const controller = new AbortController();

    const waiting = lock.acquire({ holder: 'second', signal: controller.signal });
    await Bun.sleep(30);
    controller.abort(new Error('cancelled'));

    await expect(waiting).rejects.toThrow('cancelled');
    expect(lock.status().waiting).toEqual([]);
    first.release();
  });

  test('ignores and removes the ticket of a dead client', async () => {
    const lock = newLock();
    // Our own PID with another start time: a process that reused the PID of a dead client.
    const dead = path.join(lock.dir, `ticket-1-${process.pid}.deadbeef`);
    writeFileSync(dead, JSON.stringify({ holder: 'dead', pid: process.pid, startTime: '0', requestedAt: 0, acquiredAt: 0 }));

    const lease = await lock.acquire({ holder: 'alive' });

    expect(lock.status().holder?.holder).toBe('alive');
    expect(readdirSync(lock.dir)).not.toContain(path.basename(dead));
    lease.release();
  });

  test('forceRelease hands the GPU to the next client; the old holder sees it is no longer held', async () => {
    const lock = newLock();
    const first = await lock.acquire({ holder: 'first' });
    const second = lock.acquire({ holder: 'second' });
    await Bun.sleep(30);

    expect(lock.forceRelease()?.holder).toBe('first');

    expect((await second).holder).toBe('second');
    expect(first.held).toBe(false);
    expect(lock.currentLease()).toBeUndefined();
  });
});

describe('GpuLock across processes', () => {
  test('a second process waits for the first, and gets the GPU when the first is killed', async () => {
    const lock = newLock();
    const child = Bun.spawn(['bun', CLIENT, 'hold', lock.dir], { stdout: 'pipe', stderr: 'inherit' });
    children.push(child);
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('held');

    const waiting = lock.acquire({ holder: 'parent' });
    expect(await settledWithin(waiting, 200)).toBe('pending');
    expect(lock.status().holder?.pid).toBe(child.pid);

    child.kill('SIGKILL');
    await child.exited;

    const lease = await waiting;
    expect(lease.held).toBe(true);
    lease.release();
  });

  test('never two holders at once', async () => {
    const lock = newLock();
    const log = path.join(lock.dir, '..', `${path.basename(lock.dir)}.log`);
    writeFileSync(log, '');

    const clients = Array.from({ length: 4 }, () => Bun.spawn(['bun', CLIENT, 'log', lock.dir, log, '3'], { stderr: 'inherit' }));
    children.push(...clients);
    expect(await Promise.all(clients.map((client) => client.exited))).toEqual([0, 0, 0, 0]);

    const lines = readFileSync(log, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(24);
    for (let index = 0; index < lines.length; index += 2) {
      const pid = lines[index]?.split(' ')[1];
      expect([lines[index], lines[index + 1]]).toEqual([`start ${pid}`, `end ${pid}`]);
    }
  }, 20000);
});
