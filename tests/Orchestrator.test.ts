import { describe, expect, test } from 'bun:test';
import { InvalidLauncherError } from '../src/errors';
import type { LlmLauncher } from '../src/LlmLauncher';
import { Orchestrator } from '../src/Orchestrator';
import type { ProcessController } from '../src/ProcessManager';

class FakeProcessController implements ProcessController {
  private active = new Set<string>();
  readonly startCalls: string[] = [];
  readonly stopCalls: string[] = [];

  isActive(launcher: LlmLauncher): boolean {
    return this.active.has(launcher.name);
  }

  start(launcher: LlmLauncher): number {
    this.active.add(launcher.name);
    this.startCalls.push(launcher.name);
    return 1234;
  }

  stop(launcher: LlmLauncher): void {
    this.active.delete(launcher.name);
    this.stopCalls.push(launcher.name);
  }
}

function launcher(overrides: Partial<LlmLauncher> & { name: string }): LlmLauncher {
  return {
    type: 'text-generation',
    description: 'test launcher',
    commandLine: 'echo hi',
    minimalVideoRamUsageInGigabytes: 4,
    allowFullCPU: false,
    ...overrides,
  };
}

describe('Orchestrator', () => {
  test('ensureActive starts a launcher that fits in VRAM', async () => {
    const process = new FakeProcessController();
    const orchestrator = new Orchestrator(process, 16);
    orchestrator.addLauncher(launcher({ name: 'a', minimalVideoRamUsageInGigabytes: 10 }));

    await orchestrator.ensureActive('a', false);

    expect(process.startCalls).toEqual(['a']);
    expect(orchestrator.isLauncherActive('a')).toBe(true);
  });

  test('ensureActive refuses to start a launcher that would exceed VRAM capacity', async () => {
    const process = new FakeProcessController();
    const orchestrator = new Orchestrator(process, 8);
    orchestrator.addLauncher(launcher({ name: 'a', minimalVideoRamUsageInGigabytes: 10 }));

    await expect(orchestrator.ensureActive('a', false)).rejects.toThrow(/Not enough VRAM/);
    expect(process.startCalls).toEqual([]);
  });

  test('ensureActive stops other GPU launchers before starting a new one', async () => {
    const process = new FakeProcessController();
    const orchestrator = new Orchestrator(process, 16);
    orchestrator.addLauncher(launcher({ name: 'a', minimalVideoRamUsageInGigabytes: 10 }));
    orchestrator.addLauncher(launcher({ name: 'b', minimalVideoRamUsageInGigabytes: 10 }));

    await orchestrator.ensureActive('a', false);
    await orchestrator.ensureActive('b', false);

    expect(orchestrator.isLauncherActive('a')).toBe(false);
    expect(orchestrator.isLauncherActive('b')).toBe(true);
    expect(process.stopCalls).toEqual(['a']);
  });

  test('ensureActive leaves allow_full_cpu launchers running alongside a GPU launcher', async () => {
    const process = new FakeProcessController();
    const orchestrator = new Orchestrator(process, 16);
    orchestrator.addLauncher(launcher({ name: 'cpu-only', allowFullCPU: true, minimalVideoRamUsageInGigabytes: 0 }));
    orchestrator.addLauncher(launcher({ name: 'gpu', minimalVideoRamUsageInGigabytes: 10 }));

    await orchestrator.ensureActive('cpu-only', false);
    await orchestrator.ensureActive('gpu', false);

    expect(orchestrator.isLauncherActive('cpu-only')).toBe(true);
    expect(orchestrator.isLauncherActive('gpu')).toBe(true);
    expect(process.stopCalls).toEqual([]);
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
    orchestrator.addLauncher(launcher({ name: 'gpu', minimalVideoRamUsageInGigabytes: 8 }));
    orchestrator.addLauncher(launcher({ name: 'cpu-only', allowFullCPU: true, minimalVideoRamUsageInGigabytes: 0 }));
    orchestrator.addLauncher(launcher({ name: 'idle', minimalVideoRamUsageInGigabytes: 4 }));

    await orchestrator.ensureActive('gpu', false);
    await orchestrator.ensureActive('cpu-only', false);

    orchestrator.stopAll();

    expect(process.stopCalls).toEqual(['gpu', 'cpu-only']);
    expect(orchestrator.isLauncherActive('gpu')).toBe(false);
    expect(orchestrator.isLauncherActive('cpu-only')).toBe(false);
    expect(orchestrator.isLauncherActive('idle')).toBe(false);
  });
});
