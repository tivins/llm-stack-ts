import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { parseStackConfig } from '../src/config';
import type { RemoteConfig } from '../src/config';
import { GpuBusyError, RemoteUnreachableError, StackConfigError } from '../src/errors';
import { GpuLock } from '../src/GpuLock';
import type { Launcher } from '../src/Launcher';
import type { ProcessController, StartedProcess } from '../src/ProcessManager';
import { RemoteHost } from '../src/RemoteHost';
import { Stack } from '../src/Stack';

const CLI = path.join(import.meta.dir, '../src/cli.ts');

/**
 * A "remote machine" that is a second stack on this one: its own stack file and PID directory
 * (TMPDIR), reached with `bash -c` instead of ssh. Same `stack` CLI, same JSON protocol.
 */
function fakeRemote() {
  const dir = mkdtempSync(path.join(tmpdir(), 'llm-stack-ts-remote-'));
  const file = path.join(dir, 'stack.toml');
  writeFileSync(
    file,
    [
      'vram_capacity_gb = 4',
      '[launchers.svc]',
      'command = "sleep 30"',
      'port = 18999',
      'vram_gb = 2',
      'type = "llm"',
      '[launchers.other]',
      'command = "sleep 30"',
      'port = 18998',
      'vram_gb = 2',
      '',
    ].join('\n'),
  );
  return { dir, lockDir: path.join(dir, 'stack-llm', 'gpu'), stack: `TMPDIR=${dir} XDG_STATE_HOME=${dir} bun ${CLI} -f ${file}` };
}

function localStack(remote: ReturnType<typeof fakeRemote>): { stack: Stack; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'llm-stack-ts-local-'));
  const file = path.join(dir, 'stack.toml');
  writeFileSync(
    file,
    [
      '[remotes.fake]',
      'command = ["bash", "-c"]',
      `stack = "${remote.stack}"`,
      'tunnel = false',
      'port_offset = 0',
      '[launchers.svc]',
      'remote = "fake"',
      '[launchers.alias]',
      'remote = "fake"',
      'remote_name = "other"',
      '[launchers.local]',
      'command = "sleep 31"',
      '',
    ].join('\n'),
  );
  return { stack: new Stack({ file, pidDir: path.join(dir, 'pids'), logDir: path.join(dir, 'logs') }), dir };
}

const remotes: ReturnType<typeof fakeRemote>[] = [];
afterAll(async () => {
  // Leave no `sleep 30` behind.
  for (const remote of remotes) {
    await Bun.spawn(['bash', '-c', `${remote.stack} stop svc other --force`], { stdout: 'ignore', stderr: 'ignore' }).exited;
  }
});

describe('remote launchers: config', () => {
  const base = { remotes: { forge: { ssh: 'forge' } } };

  test('a remote launcher only names its machine; the rest belongs over there', () => {
    const config = parseStackConfig({ ...base, launchers: { a: { remote: 'forge', remote_name: 'qwen', description: 'd' } } }, 'test');
    expect(config.launchers[0]).toMatchObject({ name: 'a', remote: { host: 'forge', name: 'qwen' }, gpu: false, exclusive: false, vramGb: 0 });
    expect(config.remotes[0]).toMatchObject({ name: 'forge', ssh: 'forge', stack: 'stack', portOffset: 10000, tunnel: true, wakeTimeoutMs: 120_000 });

    expect(() => parseStackConfig({ ...base, launchers: { a: { remote: 'forge', vram_gb: 4 } } }, 'test')).toThrow(/'vram_gb' belongs in that machine/);
    expect(() => parseStackConfig({ ...base, launchers: { a: { remote: 'nope' } } }, 'test')).toThrow(/remote 'nope' is not declared/);
    expect(() => parseStackConfig({ ...base, launchers: { a: { command: 'x', remote_name: 'b' } } }, 'test')).toThrow(/remote_name without remote/);
    expect(() =>
      parseStackConfig({ ...base, launchers: { a: { remote: 'forge' }, b: { extends: 'a', command: 'x' } } }, 'test'),
    ).toThrow(/cannot extend a, which runs on forge/);
  });

  test('remotes are checked', () => {
    expect(() => parseStackConfig({ remotes: { forge: {} }, launchers: {} }, 'test')).toThrow(StackConfigError);
    expect(() => parseStackConfig({ remotes: { forge: { command: ['bash', '-c'] } }, launchers: {} }, 'test')).toThrow(/tunnels need ssh/);
    expect(() => parseStackConfig({ remotes: { forge: { ssh: 'forge', wake: 'nope' } }, launchers: {} }, 'test')).toThrow(/MAC address/);
  });
});

describe('remote launchers: driven through the remote stack', () => {
  test('start, summary, status and stop go to the remote machine', async () => {
    const remote = fakeRemote();
    remotes.push(remote);
    const { stack } = localStack(remote);

    await stack.start('svc');
    expect(stack.isActive('svc')).toBe(true);
    expect(await stack.status('svc')).toBe('ready');
    expect(stack.pid('svc')).toBeNull();
    expect(stack.listSummary().svc).toMatchObject({ host: 'fake', type: 'llm', size: 2, gpu: true, exclusive: true, port: 18999, url: 'http://127.0.0.1:18999', active: true });
    expect(stack.listSummary().local).toMatchObject({ active: false, url: undefined });
    expect(stack.listSummary().local?.host).toBeUndefined();

    // remote_name: the other launcher over there; exclusive, so it replaces svc.
    await stack.start('alias');
    expect(stack.isActive('alias')).toBe(true);
    expect(stack.isActive('svc')).toBe(false);

    await stack.stop('alias');
    expect(await stack.status('alias')).toBe('inactive');
  }, 30000);

  test('withLease on a remote launcher holds the lease in the remote queue', async () => {
    const remote = fakeRemote();
    remotes.push(remote);
    const { stack } = localStack(remote);
    const remoteLock = new GpuLock(remote.lockDir);

    await stack.withLease({ holder: 'test: job', priority: 0, launcher: 'svc' }, async (lease) => {
      expect(lease.held).toBe(true);
      expect(remoteLock.status().holder).toMatchObject({ holder: `${hostname()}/test: job`, priority: 0 });
      expect(stack.gpu().holder).toBeNull();
      expect(stack.isActive('svc')).toBe(true);
      // Under the same lease, over there.
      await stack.start('alias');
      expect(stack.isActive('svc')).toBe(false);
      expect((await stack.remoteGpu()).fake?.holder?.holder).toBe(`${hostname()}/test: job`);
    });
    expect(remoteLock.status().holder).toBeNull();
    await stack.stop('alias');
  }, 30000);

  test('maxWait on a busy remote GPU gives GpuBusyError', async () => {
    const remote = fakeRemote();
    remotes.push(remote);
    const { stack } = localStack(remote);
    const busy = await new GpuLock(remote.lockDir).acquire({ holder: 'guichet: song' });
    try {
      const waits: string[] = [];
      const attempt = stack.withLease(
        { holder: 'test', launcher: 'svc', maxWait: 300, onWait: (holder) => waits.push(holder?.holder ?? '-') },
        async () => {},
      );
      await expect(attempt).rejects.toBeInstanceOf(GpuBusyError);
      expect(waits).toContain('guichet: song');
    } finally {
      busy.release();
    }
  }, 30000);
});

describe('RemoteHost', () => {
  const noProcesses: ProcessController = {
    isActive: () => false,
    getPid: () => null,
    start: (_: Launcher): StartedProcess => ({ pid: 0, exited: new Promise(() => {}) }),
    stop: async () => {},
  };
  // `bash -c 'exit 255' <command>`: ssh's exit code when it cannot connect.
  const unreachable = (overrides: Partial<RemoteConfig> = {}): RemoteConfig => ({
    name: 'forge',
    command: ['bash', '-c', 'exit 255'],
    stack: 'stack',
    wakeBroadcast: '255.255.255.255',
    wakeTimeoutMs: 100,
    portOffset: 10000,
    tunnel: false,
    ...overrides,
  });

  test('a machine that does not answer is woken up, then gives a clear error', async () => {
    const sent: string[] = [];
    const host = new RemoteHost(unreachable({ wake: 'aa:bb:cc:dd:ee:ff' }), {
      pidDir: mkdtempSync(path.join(tmpdir(), 'llm-stack-ts-rh-')),
      processes: noProcesses,
      sendWake: async (mac, broadcast) => {
        sent.push(`${mac} ${broadcast}`);
      },
      wakePollMs: 20,
    });

    await expect(host.start('qwen', {})).rejects.toThrow(/forge still cannot be reached 0 s after Wake-on-LAN/);
    expect(sent).toEqual(['aa:bb:cc:dd:ee:ff 255.255.255.255']);
  });

  test('without a wake address, the error says so; status and list never wake', async () => {
    const sent: string[] = [];
    const host = new RemoteHost(unreachable(), {
      pidDir: mkdtempSync(path.join(tmpdir(), 'llm-stack-ts-rh-')),
      processes: noProcesses,
      sendWake: async (mac) => {
        sent.push(mac);
      },
    });

    await expect(host.lease({ holder: 'x' })).rejects.toBeInstanceOf(RemoteUnreachableError);
    await expect(host.start('qwen', {})).rejects.toThrow(/no wake address/);
    expect(await host.status('qwen')).toBe('inactive');
    expect(await host.gpu()).toBeNull();
    expect(host.launchersSync()).toBeNull();
    expect(sent).toEqual([]);
  });

  test('the tunnel of a remote port is a tracked ssh -L process on port + offset', () => {
    const host = new RemoteHost({ ...unreachable(), ssh: 'forge', command: undefined, tunnel: true }, {
      pidDir: mkdtempSync(path.join(tmpdir(), 'llm-stack-ts-rh-')),
      processes: noProcesses,
    });
    expect(host.localPort(8080)).toBe(18080);
    expect(host.tunnelLauncher(8080)).toMatchObject({ name: 'tunnel.forge.8080', gpu: false });
    expect(host.tunnelLauncher(8080).commandLine).toContain('-L 127.0.0.1:18080:127.0.0.1:8080 forge');
    expect(host.argv(['start', 'a b'])).toEqual(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'forge', "stack start 'a b'"]);
  });
});
