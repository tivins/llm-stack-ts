import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GpuBusyError, GpuLeaseLostError, InvalidLauncherError } from '../src/errors';
import { GpuLock } from '../src/GpuLock';
import type { Launcher } from '../src/Launcher';
import { Orchestrator } from '../src/Orchestrator';
import type { ProcessController, StartedProcess } from '../src/ProcessManager';

class FakeProcessController implements ProcessController {
  private active = new Set<string>();
  readonly startCalls: string[] = [];
  readonly stopCalls: string[] = [];

  isActive(launcher: Launcher): boolean {
    return this.active.has(launcher.name);
  }

  getPid(launcher: Launcher): number | null {
    return this.active.has(launcher.name) ? 1234 : null;
  }

  start(launcher: Launcher): StartedProcess {
    this.active.add(launcher.name);
    this.startCalls.push(launcher.name);
    return { pid: 1234, exited: new Promise(() => {}) };
  }

  async stop(launcher: Launcher): Promise<void> {
    this.active.delete(launcher.name);
    this.stopCalls.push(launcher.name);
  }
}

function launcher(overrides: Partial<Launcher> & { name: string }): Launcher {
  return {
    type: '',
    description: 'test launcher',
    commandLine: 'echo hi',
    vramGb: 4,
    gpu: true,
    exclusive: true,
    stopTimeoutSeconds: 10,
    ...overrides,
  };
}

describe('Orchestrator', () => {
  test('ensureActive starts a launcher that fits in VRAM', async () => {
    const process = new FakeProcessController();
    const orchestrator = new Orchestrator(process, 16);
    orchestrator.addLauncher(launcher({ name: 'a', vramGb: 10 }));

    await orchestrator.ensureActive('a', { wait: false });

    expect(process.startCalls).toEqual(['a']);
    expect(orchestrator.isLauncherActive('a')).toBe(true);
  });

  test('ensureActive refuses to start a launcher that would exceed VRAM capacity', async () => {
    const process = new FakeProcessController();
    const orchestrator = new Orchestrator(process, 8);
    orchestrator.addLauncher(launcher({ name: 'a', vramGb: 10 }));

    await expect(orchestrator.ensureActive('a', { wait: false })).rejects.toThrow(/Not enough VRAM/);
    expect(process.startCalls).toEqual([]);
  });

  test('ensureActive skips the VRAM check when no capacity is configured', async () => {
    const process = new FakeProcessController();
    const orchestrator = new Orchestrator(process, undefined);
    orchestrator.addLauncher(launcher({ name: 'a', vramGb: 100 }));

    await orchestrator.ensureActive('a', { wait: false });

    expect(process.startCalls).toEqual(['a']);
  });

  test('ensureActive stops other exclusive launchers before starting an exclusive one', async () => {
    const process = new FakeProcessController();
    const orchestrator = new Orchestrator(process, 16);
    orchestrator.addLauncher(launcher({ name: 'a', vramGb: 10 }));
    orchestrator.addLauncher(launcher({ name: 'b', vramGb: 10 }));

    await orchestrator.ensureActive('a', { wait: false });
    await orchestrator.ensureActive('b', { wait: false });

    expect(orchestrator.isLauncherActive('a')).toBe(false);
    expect(orchestrator.isLauncherActive('b')).toBe(true);
    expect(process.stopCalls).toEqual(['a']);
  });

  test('ensureActive leaves CPU-only launchers running alongside an exclusive GPU launcher', async () => {
    const process = new FakeProcessController();
    const orchestrator = new Orchestrator(process, 16);
    orchestrator.addLauncher(launcher({ name: 'cpu-only', gpu: false, exclusive: false, vramGb: 0 }));
    orchestrator.addLauncher(launcher({ name: 'gpu', vramGb: 10 }));

    await orchestrator.ensureActive('cpu-only', { wait: false });
    await orchestrator.ensureActive('gpu', { wait: false });

    expect(orchestrator.isLauncherActive('cpu-only')).toBe(true);
    expect(orchestrator.isLauncherActive('gpu')).toBe(true);
    expect(process.stopCalls).toEqual([]);
  });

  test('non-exclusive GPU launchers share VRAM with an exclusive one', async () => {
    const process = new FakeProcessController();
    const orchestrator = new Orchestrator(process, 16);
    orchestrator.addLauncher(launcher({ name: 'rerank', exclusive: false, vramGb: 1 }));
    orchestrator.addLauncher(launcher({ name: 'llm', vramGb: 14 }));

    await orchestrator.ensureActive('rerank', { wait: false });
    await orchestrator.ensureActive('llm', { wait: false });

    expect(orchestrator.isLauncherActive('rerank')).toBe(true);
    expect(orchestrator.isLauncherActive('llm')).toBe(true);
  });

  test('VRAM used by non-exclusive GPU launchers counts against the budget', async () => {
    const process = new FakeProcessController();
    const orchestrator = new Orchestrator(process, 16);
    orchestrator.addLauncher(launcher({ name: 'rerank', exclusive: false, vramGb: 3 }));
    orchestrator.addLauncher(launcher({ name: 'llm', vramGb: 14 }));

    await orchestrator.ensureActive('rerank', { wait: false });

    await expect(orchestrator.ensureActive('llm', { wait: false })).rejects.toThrow(/needs 14GB, 3GB used by rerank \(capacity 16GB\)/);
  });

  test('a refused start does not stop the running exclusive launcher', async () => {
    const process = new FakeProcessController();
    const orchestrator = new Orchestrator(process, 16);
    orchestrator.addLauncher(launcher({ name: 'rerank', exclusive: false, vramGb: 4 }));
    orchestrator.addLauncher(launcher({ name: 'small', vramGb: 8 }));
    orchestrator.addLauncher(launcher({ name: 'big', vramGb: 14 }));

    await orchestrator.ensureActive('rerank', { wait: false });
    await orchestrator.ensureActive('small', { wait: false });

    await expect(orchestrator.ensureActive('big', { wait: false })).rejects.toThrow(/Not enough VRAM/);
    expect(orchestrator.isLauncherActive('small')).toBe(true);
    expect(process.stopCalls).toEqual([]);
  });

  test('VRAM freed by stopping exclusive launchers is taken into account', async () => {
    const process = new FakeProcessController();
    const orchestrator = new Orchestrator(process, 16);
    orchestrator.addLauncher(launcher({ name: 'a', vramGb: 14 }));
    orchestrator.addLauncher(launcher({ name: 'b', vramGb: 14 }));

    await orchestrator.ensureActive('a', { wait: false });
    await orchestrator.ensureActive('b', { wait: false });

    expect(process.stopCalls).toEqual(['a']);
  });

  test('getLauncherStatus reports inactive/ready without a health check', async () => {
    const process = new FakeProcessController();
    const orchestrator = new Orchestrator(process, 16);
    orchestrator.addLauncher(launcher({ name: 'a' }));

    expect(await orchestrator.getLauncherStatus('a')).toBe('inactive');

    await orchestrator.ensureActive('a', { wait: false });
    expect(await orchestrator.getLauncherStatus('a')).toBe('ready');
  });

  test('unknown launcher name throws InvalidLauncherError', async () => {
    const orchestrator = new Orchestrator(new FakeProcessController(), 16);

    expect(() => orchestrator.isLauncherActive('missing')).toThrow(InvalidLauncherError);
    await expect(orchestrator.ensureActive('missing', { wait: false })).rejects.toThrow(InvalidLauncherError);
  });

  test('stop is a no-op for an already-inactive launcher', async () => {
    const process = new FakeProcessController();
    const orchestrator = new Orchestrator(process, 16);
    orchestrator.addLauncher(launcher({ name: 'a' }));

    await orchestrator.stop('a');

    expect(process.stopCalls).toEqual([]);
  });

  test('stopAll stops every active launcher and skips inactive ones', async () => {
    const process = new FakeProcessController();
    const orchestrator = new Orchestrator(process, 32);
    orchestrator.addLauncher(launcher({ name: 'gpu', vramGb: 8 }));
    orchestrator.addLauncher(launcher({ name: 'cpu-only', gpu: false, exclusive: false, vramGb: 0 }));
    orchestrator.addLauncher(launcher({ name: 'idle', vramGb: 4 }));

    await orchestrator.ensureActive('gpu', { wait: false });
    await orchestrator.ensureActive('cpu-only', { wait: false });

    await orchestrator.stopAll();

    expect(process.stopCalls).toEqual(['gpu', 'cpu-only']);
    expect(orchestrator.isLauncherActive('gpu')).toBe(false);
    expect(orchestrator.isLauncherActive('cpu-only')).toBe(false);
    expect(orchestrator.isLauncherActive('idle')).toBe(false);
  });
});

/** Health check that never answers: nothing listens on port 1. */
const NEVER_HEALTHY = { url: 'http://127.0.0.1:1/', timeoutSeconds: 30, intervalMs: 20 };

function withGpu(): { process: FakeProcessController; orchestrator: Orchestrator; lock: GpuLock; logs: string[] } {
  const process = new FakeProcessController();
  const lock = new GpuLock(mkdtempSync(path.join(tmpdir(), 'llm-stack-ts-orch-')), { pollMs: 10 });
  const logs: string[] = [];
  const orchestrator = new Orchestrator(process, 16, { log: (message) => logs.push(message) }, undefined, { lock, holder: 'test' });
  orchestrator.addLauncher(launcher({ name: 'gpu', vramGb: 10 }));
  orchestrator.addLauncher(launcher({ name: 'other', vramGb: 10 }));
  orchestrator.addLauncher(launcher({ name: 'cpu', gpu: false, exclusive: false, vramGb: 0 }));
  orchestrator.addLauncher(launcher({ name: 'slow', vramGb: 10, health: NEVER_HEALTHY }));
  return { process, orchestrator, lock, logs };
}

async function isPending(promise: Promise<unknown>, ms = 50): Promise<boolean> {
  return Promise.race([promise.then(() => false), Bun.sleep(ms).then(() => true)]);
}

describe('Orchestrator with a GPU lease', () => {
  test('start waits while another client holds the GPU, and says who', async () => {
    const { process, orchestrator, lock, logs } = withGpu();
    const other = await lock.acquire({ holder: 'flow_editor: run 42' });

    const starting = orchestrator.ensureActive('gpu', { wait: false });

    expect(await isPending(starting)).toBe(true);
    expect(process.startCalls).toEqual([]);
    expect(logs.some((line) => /^GPU held by flow_editor: run 42 \(pid \d+\) for \d+s, waiting\.\.\.$/.test(line))).toBe(true);

    other.release();
    await starting;
    expect(process.startCalls).toEqual(['gpu']);
    expect(logs.some((line) => line.startsWith('GPU acquired after'))).toBe(true);
    expect(lock.status().holder).toBeNull();
  });

  test('force, CPU-only services and already active services do not wait', async () => {
    const { process, orchestrator, lock } = withGpu();
    await orchestrator.ensureActive('gpu', { wait: false });
    const other = await lock.acquire({ holder: 'someone' });

    await orchestrator.ensureActive('gpu', { wait: false });
    await orchestrator.ensureActive('cpu', { wait: false });
    await orchestrator.ensureActive('other', { wait: false, force: true });

    expect(process.startCalls).toEqual(['gpu', 'cpu', 'other']);
    other.release();
  });

  test('stop and stopAll wait for the GPU too', async () => {
    const { process, orchestrator, lock } = withGpu();
    await orchestrator.ensureActive('gpu', { wait: false });
    const other = await lock.acquire({ holder: 'someone' });

    const stopping = orchestrator.stopAll();
    expect(await isPending(stopping)).toBe(true);
    expect(process.stopCalls).toEqual([]);

    other.release();
    await stopping;
    expect(process.stopCalls).toEqual(['gpu']);
  });

  test('inside withLease, start and stop use the lease instead of waiting for themselves', async () => {
    const { process, orchestrator, lock } = withGpu();

    await orchestrator.withLease({ holder: 'persona_helper: batch' }, async () => {
      expect(lock.status().holder?.holder).toBe('persona_helper: batch');
      await orchestrator.ensureActive('gpu', { wait: false });
      await orchestrator.ensureActive('other', { wait: false });
      await orchestrator.restart('other', { wait: false });
    });

    expect(process.startCalls).toEqual(['gpu', 'other', 'other']);
    expect(process.stopCalls).toEqual(['gpu', 'other']);
    expect(lock.status().holder).toBeNull();
  });

  test('a job with a launcher starts it under the lease before running', async () => {
    const { process, orchestrator, lock } = withGpu();

    const result = await orchestrator.withLease({ holder: 'chat', priority: 0, launcher: 'gpu' }, async () => {
      expect(process.startCalls).toEqual(['gpu']);
      expect(lock.status().holder?.priority).toBe(0);
      expect(lock.status().holder?.launcher).toBe('gpu');
      return 'reply';
    });

    expect(result).toBe('reply');
    expect(lock.status().holder).toBeNull();
  });

  test('start forwards priority, maxWait and onWait to the lease it takes', async () => {
    const { process, orchestrator, lock } = withGpu();
    const other = await lock.acquire({ holder: 'comfyui batch' });
    const seen: (string | undefined)[] = [];

    const starting = orchestrator.ensureActive('gpu', {
      wait: false,
      priority: 0,
      maxWait: 60,
      onWait: (holder) => seen.push(holder?.holder),
    });

    await expect(starting).rejects.toThrow(GpuBusyError);
    expect(seen).toEqual(['comfyui batch']);
    expect(process.startCalls).toEqual([]);
    other.release();
  });

  test('an explicit lease is used across calls, and refused once broken', async () => {
    const { process, orchestrator, lock } = withGpu();
    const lease = await orchestrator.acquireLease({ holder: 'flow_editor: run 7' });

    await orchestrator.ensureActive('gpu', { wait: false, lease });
    expect(process.startCalls).toEqual(['gpu']);

    expect(orchestrator.breakLease()?.holder).toBe('flow_editor: run 7');
    await expect(orchestrator.stop('gpu', { lease })).rejects.toThrow(GpuLeaseLostError);
    expect(process.stopCalls).toEqual([]);
    expect(lock.status().holder).toBeNull();
  });

  test('aborting while waiting for the GPU starts nothing', async () => {
    const { process, orchestrator, lock } = withGpu();
    const other = await lock.acquire({ holder: 'someone' });
    const controller = new AbortController();

    const starting = orchestrator.ensureActive('gpu', { signal: controller.signal });
    await Bun.sleep(30);
    controller.abort(new Error('cancelled'));

    await expect(starting).rejects.toThrow('cancelled');
    expect(process.startCalls).toEqual([]);
    expect(lock.status().waiting).toEqual([]);
    other.release();
  });

  test('aborting during the health check stops the process this call started', async () => {
    const { process, orchestrator, lock } = withGpu();
    const controller = new AbortController();

    const starting = orchestrator.ensureActive('slow', { signal: controller.signal });
    await Bun.sleep(50);
    controller.abort(new Error('cancelled'));

    await expect(starting).rejects.toThrow('cancelled');
    expect(process.startCalls).toEqual(['slow']);
    expect(process.stopCalls).toEqual(['slow']);
    expect(lock.status().holder).toBeNull();
  });

  test('aborting the wait for a service that was already running leaves it running', async () => {
    const { process, orchestrator } = withGpu();
    await orchestrator.ensureActive('slow', { wait: false });
    const controller = new AbortController();

    const waiting = orchestrator.ensureActive('slow', { signal: controller.signal });
    await Bun.sleep(50);
    controller.abort(new Error('cancelled'));

    await expect(waiting).rejects.toThrow('cancelled');
    expect(process.stopCalls).toEqual([]);
    expect(orchestrator.isLauncherActive('slow')).toBe(true);
  });
});
