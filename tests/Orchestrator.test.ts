import { describe, expect, test } from 'bun:test';
import { InvalidLauncherError } from '../src/errors';
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

  stop(launcher: Launcher): void {
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

    await orchestrator.ensureActive('a', false);

    expect(process.startCalls).toEqual(['a']);
    expect(orchestrator.isLauncherActive('a')).toBe(true);
  });

  test('ensureActive refuses to start a launcher that would exceed VRAM capacity', async () => {
    const process = new FakeProcessController();
    const orchestrator = new Orchestrator(process, 8);
    orchestrator.addLauncher(launcher({ name: 'a', vramGb: 10 }));

    await expect(orchestrator.ensureActive('a', false)).rejects.toThrow(/Not enough VRAM/);
    expect(process.startCalls).toEqual([]);
  });

  test('ensureActive skips the VRAM check when no capacity is configured', async () => {
    const process = new FakeProcessController();
    const orchestrator = new Orchestrator(process, undefined);
    orchestrator.addLauncher(launcher({ name: 'a', vramGb: 100 }));

    await orchestrator.ensureActive('a', false);

    expect(process.startCalls).toEqual(['a']);
  });

  test('ensureActive stops other exclusive launchers before starting an exclusive one', async () => {
    const process = new FakeProcessController();
    const orchestrator = new Orchestrator(process, 16);
    orchestrator.addLauncher(launcher({ name: 'a', vramGb: 10 }));
    orchestrator.addLauncher(launcher({ name: 'b', vramGb: 10 }));

    await orchestrator.ensureActive('a', false);
    await orchestrator.ensureActive('b', false);

    expect(orchestrator.isLauncherActive('a')).toBe(false);
    expect(orchestrator.isLauncherActive('b')).toBe(true);
    expect(process.stopCalls).toEqual(['a']);
  });

  test('ensureActive leaves CPU-only launchers running alongside an exclusive GPU launcher', async () => {
    const process = new FakeProcessController();
    const orchestrator = new Orchestrator(process, 16);
    orchestrator.addLauncher(launcher({ name: 'cpu-only', gpu: false, exclusive: false, vramGb: 0 }));
    orchestrator.addLauncher(launcher({ name: 'gpu', vramGb: 10 }));

    await orchestrator.ensureActive('cpu-only', false);
    await orchestrator.ensureActive('gpu', false);

    expect(orchestrator.isLauncherActive('cpu-only')).toBe(true);
    expect(orchestrator.isLauncherActive('gpu')).toBe(true);
    expect(process.stopCalls).toEqual([]);
  });

  test('non-exclusive GPU launchers share VRAM with an exclusive one', async () => {
    const process = new FakeProcessController();
    const orchestrator = new Orchestrator(process, 16);
    orchestrator.addLauncher(launcher({ name: 'rerank', exclusive: false, vramGb: 1 }));
    orchestrator.addLauncher(launcher({ name: 'llm', vramGb: 14 }));

    await orchestrator.ensureActive('rerank', false);
    await orchestrator.ensureActive('llm', false);

    expect(orchestrator.isLauncherActive('rerank')).toBe(true);
    expect(orchestrator.isLauncherActive('llm')).toBe(true);
  });

  test('VRAM used by non-exclusive GPU launchers counts against the budget', async () => {
    const process = new FakeProcessController();
    const orchestrator = new Orchestrator(process, 16);
    orchestrator.addLauncher(launcher({ name: 'rerank', exclusive: false, vramGb: 3 }));
    orchestrator.addLauncher(launcher({ name: 'llm', vramGb: 14 }));

    await orchestrator.ensureActive('rerank', false);

    await expect(orchestrator.ensureActive('llm', false)).rejects.toThrow(/needs 14GB, 3GB used by rerank \(capacity 16GB\)/);
  });

  test('a refused start does not stop the running exclusive launcher', async () => {
    const process = new FakeProcessController();
    const orchestrator = new Orchestrator(process, 16);
    orchestrator.addLauncher(launcher({ name: 'rerank', exclusive: false, vramGb: 4 }));
    orchestrator.addLauncher(launcher({ name: 'small', vramGb: 8 }));
    orchestrator.addLauncher(launcher({ name: 'big', vramGb: 14 }));

    await orchestrator.ensureActive('rerank', false);
    await orchestrator.ensureActive('small', false);

    await expect(orchestrator.ensureActive('big', false)).rejects.toThrow(/Not enough VRAM/);
    expect(orchestrator.isLauncherActive('small')).toBe(true);
    expect(process.stopCalls).toEqual([]);
  });

  test('VRAM freed by stopping exclusive launchers is taken into account', async () => {
    const process = new FakeProcessController();
    const orchestrator = new Orchestrator(process, 16);
    orchestrator.addLauncher(launcher({ name: 'a', vramGb: 14 }));
    orchestrator.addLauncher(launcher({ name: 'b', vramGb: 14 }));

    await orchestrator.ensureActive('a', false);
    await orchestrator.ensureActive('b', false);

    expect(process.stopCalls).toEqual(['a']);
  });

  test('getLauncherStatus reports inactive/ready without a health check', async () => {
    const process = new FakeProcessController();
    const orchestrator = new Orchestrator(process, 16);
    orchestrator.addLauncher(launcher({ name: 'a' }));

    expect(await orchestrator.getLauncherStatus('a')).toBe('inactive');

    await orchestrator.ensureActive('a', false);
    expect(await orchestrator.getLauncherStatus('a')).toBe('ready');
  });

  test('unknown launcher name throws InvalidLauncherError', async () => {
    const orchestrator = new Orchestrator(new FakeProcessController(), 16);

    expect(() => orchestrator.isLauncherActive('missing')).toThrow(InvalidLauncherError);
    await expect(orchestrator.ensureActive('missing', false)).rejects.toThrow(InvalidLauncherError);
  });

  test('stop is a no-op for an already-inactive launcher', () => {
    const process = new FakeProcessController();
    const orchestrator = new Orchestrator(process, 16);
    orchestrator.addLauncher(launcher({ name: 'a' }));

    orchestrator.stop('a');

    expect(process.stopCalls).toEqual([]);
  });

  test('stopAll stops every active launcher and skips inactive ones', async () => {
    const process = new FakeProcessController();
    const orchestrator = new Orchestrator(process, 32);
    orchestrator.addLauncher(launcher({ name: 'gpu', vramGb: 8 }));
    orchestrator.addLauncher(launcher({ name: 'cpu-only', gpu: false, exclusive: false, vramGb: 0 }));
    orchestrator.addLauncher(launcher({ name: 'idle', vramGb: 4 }));

    await orchestrator.ensureActive('gpu', false);
    await orchestrator.ensureActive('cpu-only', false);

    orchestrator.stopAll();

    expect(process.stopCalls).toEqual(['gpu', 'cpu-only']);
    expect(orchestrator.isLauncherActive('gpu')).toBe(false);
    expect(orchestrator.isLauncherActive('cpu-only')).toBe(false);
    expect(orchestrator.isLauncherActive('idle')).toBe(false);
  });
});
