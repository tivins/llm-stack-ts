import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GpuLock } from '../src/GpuLock';
import type { Launcher } from '../src/Launcher';
import { runLeaseSession } from '../src/leaseSession';
import type { LeaseEvent } from '../src/leaseSession';
import { Orchestrator } from '../src/Orchestrator';
import type { ProcessController, StartedProcess } from '../src/ProcessManager';

class FakeProcessController implements ProcessController {
  private active = new Set<string>();
  readonly calls: string[] = [];

  isActive(launcher: Launcher): boolean {
    return this.active.has(launcher.name);
  }

  getPid(launcher: Launcher): number | null {
    return this.active.has(launcher.name) ? 1234 : null;
  }

  start(launcher: Launcher): StartedProcess {
    this.active.add(launcher.name);
    this.calls.push(`start ${launcher.name}`);
    return { pid: 1234, exited: new Promise(() => {}) };
  }

  async stop(launcher: Launcher): Promise<void> {
    this.active.delete(launcher.name);
    this.calls.push(`stop ${launcher.name}`);
  }
}

function launcher(name: string): Launcher {
  return { name, type: '', description: '', commandLine: 'echo hi', vramGb: 10, gpu: true, exclusive: true, stopTimeoutSeconds: 10 };
}

function setup() {
  const process = new FakeProcessController();
  const lock = new GpuLock(mkdtempSync(path.join(tmpdir(), 'llm-stack-ts-lease-')), { pollMs: 10 });
  const orchestrator = new Orchestrator(process, 16, undefined, undefined, { lock, holder: 'test' });
  orchestrator.addLauncher(launcher('a'));
  orchestrator.addLauncher(launcher('b'));
  return { process, lock, orchestrator };
}

/** A stdin the test writes to line by line, then closes. */
class Input implements AsyncIterable<string> {
  private lines: string[] = [];
  private closed = false;
  private wake?: () => void;

  push(line: string): void {
    this.lines.push(line);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    while (true) {
      const line = this.lines.shift();
      if (line !== undefined) {
        yield line;
      } else if (this.closed) {
        return;
      } else {
        await new Promise<void>((resolve) => (this.wake = resolve));
      }
    }
  }
}

function waitFor(events: LeaseEvent[], kind: LeaseEvent['event'], count = 1): Promise<void> {
  return new Promise((resolve) => {
    const check = () => (events.filter((e) => e.event === kind).length >= count ? resolve() : setTimeout(check, 5));
    check();
  });
}

describe('runLeaseSession', () => {
  test('starts the launcher, runs commands under the lease, releases when stdin closes', async () => {
    const { process, lock, orchestrator } = setup();
    const input = new Input();
    const events: LeaseEvent[] = [];

    const session = runLeaseSession(orchestrator, { holder: 'pc: chat', priority: 0, launcher: 'a', pollMs: 10 }, input, (e) => events.push(e));
    await waitFor(events, 'granted');
    expect(lock.status().holder?.holder).toBe('pc: chat');
    expect(process.calls).toEqual(['start a']);

    input.push('start b');
    input.push('touch');
    await waitFor(events, 'done', 2);
    expect(process.calls).toEqual(['start a', 'stop a', 'start b']);
    expect(lock.status().holder?.holder).toBe('pc: chat');

    input.close();
    expect(await session).toBe('stdin');
    expect(lock.status().holder).toBeNull();
    expect(events.map((e) => e.event)).toEqual(['granted', 'done', 'done', 'released']);
    expect(events[0]).toMatchObject({ event: 'granted', priority: 0, launcher: 'a' });
  });

  test('a failed command is reported and the session goes on', async () => {
    const { orchestrator } = setup();
    const input = new Input();
    const events: LeaseEvent[] = [];

    const session = runLeaseSession(orchestrator, { holder: 'x', pollMs: 10 }, input, (e) => events.push(e));
    input.push('start missing');
    input.push('dance');
    input.push('release');

    expect(await session).toBe('release');
    expect(events.map((e) => e.event)).toEqual(['granted', 'error', 'error', 'released']);
    expect(events[1]).toMatchObject({ cmd: 'start missing' });
    expect(events[2]).toMatchObject({ cmd: 'dance', message: expect.stringContaining('unknown command') });
  });

  test('closing stdin while waiting leaves the queue', async () => {
    const { lock, orchestrator } = setup();
    const other = await lock.acquire({ holder: 'guichet', priority: 2 });
    const input = new Input();
    const events: LeaseEvent[] = [];

    const session = runLeaseSession(orchestrator, { holder: 'pc', pollMs: 10 }, input, (e) => events.push(e));
    await waitFor(events, 'waiting');
    expect(events[0]).toMatchObject({ event: 'waiting', position: 0, reason: 'turn' });
    expect(lock.status().waiting.map((l) => l.holder)).toEqual(['pc']);

    input.close();
    expect(await session).toBe('stdin');
    expect(events.at(-1)).toEqual({ event: 'cancelled', why: 'stdin' });
    expect(lock.status().waiting).toEqual([]);
    other.release();
  });

  test('a signal releases the lease', async () => {
    const { lock, orchestrator } = setup();
    const input = new Input();
    const events: LeaseEvent[] = [];
    const interrupted = new AbortController();

    const session = runLeaseSession(orchestrator, { holder: 'pc', signal: interrupted.signal, pollMs: 10 }, input, (e) => events.push(e));
    await waitFor(events, 'granted');
    interrupted.abort();

    expect(await session).toBe('signal');
    expect(lock.status().holder).toBeNull();
  });

  test('a broken lease ends the session', async () => {
    const { lock, orchestrator } = setup();
    const input = new Input();
    const events: LeaseEvent[] = [];

    const session = runLeaseSession(orchestrator, { holder: 'pc', pollMs: 10 }, input, (e) => events.push(e));
    await waitFor(events, 'granted');
    lock.forceRelease();

    expect(await session).toBe('broken');
    expect(events.at(-1)).toEqual({ event: 'released', why: 'broken' });
  });
});
