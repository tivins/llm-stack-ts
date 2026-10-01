import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Launcher } from '../src/Launcher';
import { Orchestrator } from '../src/Orchestrator';
import { ProcessManager } from '../src/ProcessManager';

const started: Array<[ProcessManager, Launcher]> = [];

function setup(): { dir: string; manager: ProcessManager } {
  const dir = mkdtempSync(path.join(tmpdir(), 'llm-stack-ts-pm-'));
  return { dir, manager: new ProcessManager(path.join(dir, 'pid'), undefined, path.join(dir, 'logs')) };
}

function launcher(overrides: Partial<Launcher> & { name: string; commandLine: string }): Launcher {
  return { type: '', description: '', vramGb: 0, gpu: false, exclusive: false, stopTimeoutSeconds: 2, ...overrides };
}

function start(manager: ProcessManager, l: Launcher) {
  started.push([manager, l]);
  return manager.start(l);
}

/** Unique `sleep` duration so tests never match unrelated processes. */
function uniqueSleep(): string {
  return `${1000 + Math.floor(Math.random() * 1000)}.${process.pid}`;
}

function processesMatching(pattern: string): number[] {
  return readdirSync('/proc')
    .filter((entry) => /^\d+$/.test(entry))
    .filter((entry) => {
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf-8');
        const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
        return state !== 'Z' && readFileSync(`/proc/${entry}/cmdline`, 'utf-8').replace(/\0/g, ' ').includes(pattern);
      } catch {
        return false;
      }
    })
    .map(Number);
}

afterEach(() => {
  for (const [manager, l] of started.splice(0)) {
    manager.stop(l);
  }
});

describe('ProcessManager', () => {
  test('a wrapper script that execs into the real process stays tracked (process_match not yet visible)', async () => {
    const { dir, manager } = setup();
    const duration = uniqueSleep();
    const script = path.join(dir, 'start.sh');
    writeFileSync(script, `#!/usr/bin/env bash\nsleep 0.3\nexec sleep ${duration}\n`);
    chmodSync(script, 0o755);
    const l = launcher({ name: 'wrapped', commandLine: script, processMatch: `sleep ${duration}` });

    const { pid } = start(manager, l);

    expect(manager.isActive(l)).toBe(true);
    await Bun.sleep(600);
    expect(manager.getPid(l)).toBe(pid);
    expect(processesMatching(`sleep ${duration}`)).toEqual([pid]);
  });

  test('stop terminates the whole process group', async () => {
    const { manager } = setup();
    const duration = uniqueSleep();
    const l = launcher({ name: 'group', commandLine: `bash -c 'sleep ${duration} & sleep ${duration} & wait'` });

    start(manager, l);
    await Bun.sleep(200);
    // The two sleeps plus the `bash -c` wrapper, whose command line contains them too.
    expect(processesMatching(`sleep ${duration}`)).toHaveLength(3);

    manager.stop(l);

    expect(processesMatching(`sleep ${duration}`)).toEqual([]);
    expect(manager.isActive(l)).toBe(false);
  });

  test('stdout and stderr go to the log file, previous run kept as .1', async () => {
    const { manager } = setup();
    const duration = uniqueSleep();
    const l = launcher({ name: 'logged', commandLine: `bash -c 'echo out-$RUN; echo err-$RUN >&2; exec sleep ${duration}'` });

    start(manager, { ...l, env: { RUN: 'one' } });
    await Bun.sleep(200);
    manager.stop(l);
    start(manager, { ...l, env: { RUN: 'two' } });
    await Bun.sleep(200);

    expect(readFileSync(manager.logFile(l), 'utf-8')).toBe('out-two\nerr-two\n');
    expect(readFileSync(`${manager.logFile(l)}.1`, 'utf-8')).toBe('out-one\nerr-one\n');
  });

  test('runs the command in the configured cwd', async () => {
    const { dir, manager } = setup();
    const l = launcher({ name: 'cwd', commandLine: 'pwd', cwd: dir });

    const { exited } = start(manager, l);
    await exited;

    expect(readFileSync(manager.logFile(l), 'utf-8').trim()).toBe(dir);
  });

  test('two launchers sharing a process_match do not claim the same process', () => {
    const { manager } = setup();
    const duration = uniqueSleep();
    const a = launcher({ name: 'a', commandLine: `sleep ${duration}`, processMatch: `sleep ${duration}` });
    const b = launcher({ name: 'b', commandLine: `sleep ${duration}`, processMatch: `sleep ${duration}` });

    start(manager, a);

    expect(manager.isActive(a)).toBe(true);
    expect(manager.isActive(b)).toBe(false);
  });

  test('adopts a legacy PID file that only contains the PID', () => {
    const { dir, manager } = setup();
    const duration = uniqueSleep();
    const l = launcher({ name: 'legacy', commandLine: `sleep ${duration}` });
    const { pid } = start(manager, l);

    writeFileSync(path.join(dir, 'pid', 'legacy.pid'), String(pid));

    expect(manager.getPid(l)).toBe(pid);
    expect(readFileSync(path.join(dir, 'pid', 'legacy.pid'), 'utf-8')).toMatch(new RegExp(`^${pid} \\d+$`));
  });
});

describe('Orchestrator with real processes', () => {
  test('reports the exit code and log tail when the process dies before becoming healthy', async () => {
    const { manager } = setup();
    const orchestrator = new Orchestrator(manager, undefined);
    orchestrator.addLauncher(
      launcher({
        name: 'crashy',
        commandLine: `bash -c 'echo "boom: missing model" >&2; exit 3'`,
        health: { url: 'http://127.0.0.1:1/', timeoutSeconds: 10, intervalMs: 100 },
      }),
    );

    const error = await orchestrator.ensureActive('crashy').catch((err: Error) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('crashy exited with code 3 before becoming ready');
    expect((error as Error).message).toContain('| boom: missing model');
  });

  test('detects an immediate crash without health check', async () => {
    const { manager } = setup();
    const orchestrator = new Orchestrator(manager, undefined);
    orchestrator.addLauncher(launcher({ name: 'crashy', commandLine: 'false' }));

    await expect(orchestrator.ensureActive('crashy')).rejects.toThrow(/crashy exited with code 1/);
  });

  test('becomes ready once the health endpoint answers 2xx', async () => {
    const { manager } = setup();
    const server = Bun.serve({ port: 0, fetch: () => new Response('ok', { status: 204 }) });
    try {
      const orchestrator = new Orchestrator(manager, undefined);
      const l = launcher({
        name: 'healthy',
        commandLine: `sleep ${uniqueSleep()}`,
        health: { url: `http://127.0.0.1:${server.port}/`, timeoutSeconds: 5, intervalMs: 100 },
      });
      orchestrator.addLauncher(l);
      started.push([manager, l]);

      await orchestrator.ensureActive('healthy');

      expect(await orchestrator.getLauncherStatus('healthy')).toBe('ready');
    } finally {
      server.stop(true);
    }
  });
});
