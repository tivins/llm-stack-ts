import { createSocket } from 'node:dgram';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { shellQuote } from './args';
import type { RemoteConfig } from './config';
import { GpuBusyError, GpuLeaseLostError, RemoteUnreachableError } from './errors';
import { GpuLease } from './GpuLock';
import type { GpuStatus, JobPriority, LeaseInfo, QueuePosition } from './GpuLock';
import type { Launcher } from './Launcher';
import type { LauncherStatus } from './LauncherStatus';
import type { Logger } from './Logger';
import type { ProcessController } from './ProcessManager';
import { sleep } from './sleep';

/** `stack list-json` of the remote machine, for one launcher. */
export interface RemoteLauncherInfo {
  readonly type: string;
  readonly description: string;
  readonly active: boolean;
  readonly size: number;
  readonly gpu: boolean;
  readonly exclusive: boolean;
  readonly extends?: string;
  readonly model?: string;
  readonly ctxSize?: number;
  readonly reasoningBudget?: number;
  /** Port on the remote machine. */
  readonly port?: number;
}

/** A JSON line written by the remote `stack ... --json`. */
interface RemoteEvent {
  event: string;
  cmd?: string;
  message?: string;
  holder?: LeaseInfo | null;
  position?: number;
  reason?: QueuePosition['reason'];
  id?: string;
  priority?: JobPriority;
  why?: string;
}

export interface RemoteRunOptions {
  signal?: AbortSignal;
  /** Wakes the machine (Wake-on-LAN) and retries once when ssh cannot reach it. Default true. */
  wake?: boolean;
  onEvent?: (event: RemoteEvent) => void;
}

export interface RemoteRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly events: RemoteEvent[];
}

export interface RemoteCallOptions {
  priority?: JobPriority;
  maxWait?: number;
  force?: boolean;
  signal?: AbortSignal;
  onWait?: (holder: LeaseInfo | null, me: QueuePosition) => void;
}

export interface RemoteHostOptions {
  /** PID files and caches; the tunnels are tracked there like services. */
  pidDir: string;
  /** Runs the tunnels (`ssh -N -L ...`) as tracked processes. */
  processes: ProcessController;
  logger?: Logger;
  /** Sends the Wake-on-LAN packet; replaced in tests. */
  sendWake?: (mac: string, broadcast: string) => Promise<void>;
  /** Pause between two attempts to reach a machine that is waking up. Default 3 s. */
  wakePollMs?: number;
}

/** ssh exits with 255 when it cannot connect (and on its own errors). */
const SSH_UNREACHABLE = 255;
/** A list is reused this long before asking the remote machine again. */
const LIST_TTL_MS = 2000;
/** After a failed attempt, the machine is not asked again (synchronously) before this delay. */
const UNREACHABLE_TTL_MS = 30_000;
const TUNNEL_START_TIMEOUT_MS = 15_000;
/** `touch()` reaches each remote machine at most this often. */
const TOUCH_INTERVAL_MS = 10_000;

/** `http://127.0.0.1:<port>` reachable with a TCP connection. */
async function portOpen(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: '127.0.0.1', port, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/** Magic packet: 6 bytes 0xFF then the MAC address 16 times, to UDP port 9. */
export async function sendWakeOnLan(mac: string, broadcast: string): Promise<void> {
  const bytes = Buffer.from(mac.replace(/[:-]/g, ''), 'hex');
  const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => bytes)]);
  const socket = createSocket('udp4');
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(() => {
        socket.setBroadcast(true);
        socket.send(packet, 9, broadcast, (err) => (err ? reject(err) : resolve()));
      });
    });
  } finally {
    socket.close();
  }
}

/** A `LeaseInfo` read from JSON: its dates are strings again. */
function reviveLease(raw: LeaseInfo | null | undefined): LeaseInfo | null {
  if (raw === null || raw === undefined) return null;
  const { requestedAt, acquiredAt } = raw as unknown as { requestedAt: string; acquiredAt?: string };
  return { ...raw, requestedAt: new Date(requestedAt), acquiredAt: acquiredAt === undefined ? undefined : new Date(acquiredAt) };
}

function reviveStatus(raw: GpuStatus): GpuStatus {
  return { holder: reviveLease(raw.holder), waiting: raw.waiting.map((lease) => reviveLease(lease) as LeaseInfo) };
}

function parseEvents(stdout: string): RemoteEvent[] {
  const events: RemoteEvent[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const event = JSON.parse(line) as RemoteEvent;
      if (event.holder !== undefined) event.holder = reviveLease(event.holder);
      events.push(event);
    } catch {
      // Not one of ours.
    }
  }
  return events;
}

/** Reads a stream line by line. */
async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let at: number;
    while ((at = buffer.indexOf('\n')) !== -1) {
      yield buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
    }
  }
  if (buffer !== '') yield buffer;
}

/**
 * Lease held on another machine by `stack lease` run over ssh: the remote process holds the
 * lease in that machine's queue for as long as this one keeps its stdin open. `release()`
 * closes it; if this process dies, ssh closes it too.
 */
export class RemoteLease extends GpuLease {
  private open = true;
  private readonly pending: { cmd: string; resolve: () => void; reject: (err: Error) => void }[] = [];

  constructor(
    /** Name of the remote machine (`[remotes.<name>]`). */
    readonly remote: string,
    id: string,
    holder: string,
    priority: JobPriority,
    private readonly proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>,
  ) {
    super(`remote:${remote}`, id, holder, '', priority);
  }

  override get held(): boolean {
    return this.open;
  }

  override release(): void {
    if (!this.open) return;
    this.open = false;
    try {
      this.proc.stdin.end();
    } catch {
      // Already closed.
    }
    this.failPending(new GpuLeaseLostError(`GPU lease of ${this.holder} on ${this.remote} was released`));
  }

  /** Resolves once the remote `stack lease` has ended (after `release()`), or after `timeoutMs`. */
  async closed(timeoutMs = 5000): Promise<void> {
    await Promise.race([this.proc.exited, Bun.sleep(timeoutMs)]);
  }

  /** Runs `start <name>`, `restart <name>`, `stop <name>` or `touch` under the lease, on the remote machine. */
  command(cmd: string): Promise<void> {
    if (!this.open) {
      return Promise.reject(new GpuLeaseLostError(`GPU lease of ${this.holder} on ${this.remote} is no longer held`));
    }
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ cmd, resolve, reject });
      this.proc.stdin.write(`${cmd}\n`);
      this.proc.stdin.flush();
    });
  }

  /** @internal Fed with the events that follow `granted`. */
  onEvent(event: RemoteEvent): void {
    if (event.event === 'done' || (event.event === 'error' && event.cmd !== undefined)) {
      const next = this.pending.shift();
      if (event.event === 'done') next?.resolve();
      else next?.reject(new Error(`${this.remote}: ${event.message ?? 'command failed'}`));
    } else if (event.event === 'released') {
      this.lost(event.why === 'broken' ? 'broken by another client' : 'released');
    }
  }

  /** @internal The ssh process ended. */
  lost(why: string): void {
    if (!this.open) return;
    this.open = false;
    this.failPending(new GpuLeaseLostError(`GPU lease of ${this.holder} on ${this.remote} ${why}`));
  }

  private failPending(err: Error): void {
    for (const p of this.pending.splice(0)) p.reject(err);
  }
}

/**
 * Another machine whose services are driven by its own `stack` CLI over ssh (see
 * `[remotes.<name>]`): start/stop/status, the GPU lease held in its queue (`stack lease`), the
 * ssh tunnels to its services, and Wake-on-LAN when it does not answer.
 */
export class RemoteHost {
  readonly name: string;
  private readonly cacheFile: string;
  private list?: { at: number; launchers: Record<string, RemoteLauncherInfo> };
  private unreachableAt?: number;
  private lastTouch = 0;

  constructor(
    readonly config: RemoteConfig,
    private readonly options: RemoteHostOptions,
  ) {
    this.name = config.name;
    const dir = path.join(options.pidDir, 'remotes');
    mkdirSync(dir, { recursive: true });
    this.cacheFile = path.join(dir, `${config.name}.json`);
  }

  /** Argv running `stack <args>` on the remote machine. */
  argv(args: string[], connectTimeoutSeconds = 5): string[] {
    const remote = [this.config.stack, ...args.map(shellQuote)].join(' ');
    const prefix = this.config.command ?? ['ssh', '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${connectTimeoutSeconds}`, this.config.ssh as string];
    return [...prefix, remote];
  }

  /** Runs `stack <args>` remotely; wakes the machine and retries once if it cannot be reached. */
  async run(args: string[], options: RemoteRunOptions = {}): Promise<RemoteRunResult> {
    let result = await this.runOnce(args, options);
    if (result.code === SSH_UNREACHABLE && result.events.length === 0 && (options.wake ?? true)) {
      await this.wakeUp(options.signal, result.stderr);
      result = await this.runOnce(args, options);
    }
    if (result.code === SSH_UNREACHABLE && result.events.length === 0) {
      this.unreachableAt = Date.now();
      throw new RemoteUnreachableError(`${this.name} cannot be reached: ${result.stderr.trim() || 'ssh failed'}`);
    }
    this.unreachableAt = undefined;
    return result;
  }

  /** Remote command that must succeed; its JSON error (or stderr) becomes the error message. */
  private async runChecked(args: string[], options: RemoteRunOptions & { busyHolder?: string } = {}): Promise<RemoteRunResult> {
    let lastHolder: LeaseInfo | null = null;
    const result = await this.run(args, {
      ...options,
      onEvent: (event) => {
        if (event.event === 'waiting') lastHolder = event.holder ?? null;
        options.onEvent?.(event);
      },
    });
    if (result.code !== 0) {
      const message = result.events.find((e) => e.event === 'error')?.message ?? (result.stderr.trim() || `exit code ${result.code}`);
      if (/gave up waiting/.test(message) && options.busyHolder !== undefined) {
        throw new GpuBusyError(options.busyHolder, { holder: lastHolder, waiting: [] });
      }
      throw new Error(`${this.name}: ${message}`);
    }
    return result;
  }

  private async runOnce(args: string[], options: RemoteRunOptions): Promise<RemoteRunResult> {
    options.signal?.throwIfAborted();
    const proc = Bun.spawn(this.argv(args), { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const onAbort = () => proc.kill();
    options.signal?.addEventListener('abort', onAbort);
    try {
      const events: RemoteEvent[] = [];
      let stdout = '';
      const reading = (async () => {
        for await (const line of readLines(proc.stdout)) {
          stdout += `${line}\n`;
          const [event] = parseEvents(line);
          if (event) {
            events.push(event);
            options.onEvent?.(event);
          }
        }
      })();
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited, reading]);
      options.signal?.throwIfAborted();
      return { code, stdout, stderr, events };
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Sends the Wake-on-LAN packet and waits until ssh gets through, or fails with `RemoteUnreachableError`. */
  async wakeUp(signal?: AbortSignal, reason = ''): Promise<void> {
    const { wake, wakeBroadcast, wakeTimeoutMs } = this.config;
    if (wake === undefined) {
      throw new RemoteUnreachableError(`${this.name} cannot be reached${reason.trim() ? `: ${reason.trim()}` : ''} (no wake address to wake it up)`);
    }
    this.options.logger?.log(`${this.name} does not answer, waking it up (Wake-on-LAN ${wake})...`);
    await (this.options.sendWake ?? sendWakeOnLan)(wake, wakeBroadcast);
    const deadline = Date.now() + wakeTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(this.options.wakePollMs ?? 3000, signal);
      const probe = Bun.spawnSync(this.argv(['--help'], 3), { stdout: 'ignore', stderr: 'ignore' });
      if (probe.exitCode !== SSH_UNREACHABLE) {
        this.options.logger?.log(`${this.name} is awake.`);
        return;
      }
    }
    throw new RemoteUnreachableError(`${this.name} still cannot be reached ${Math.round(wakeTimeoutMs / 1000)} s after Wake-on-LAN`);
  }

  /**
   * The remote launchers, from `stack list-json`, without waking the machine. Synchronous (for
   * `Stack.listSummary`, `isActive`); reused for 2 s. Null when the machine cannot be reached.
   */
  launchersSync(): Record<string, RemoteLauncherInfo> | null {
    if (this.list && Date.now() - this.list.at < LIST_TTL_MS) return this.list.launchers;
    if (this.unreachableAt !== undefined && Date.now() - this.unreachableAt < UNREACHABLE_TTL_MS) return null;
    const result = Bun.spawnSync(this.argv(['list-json'], 2), { stdout: 'pipe', stderr: 'pipe' });
    return this.storeList(result.exitCode, result.stdout.toString());
  }

  /** Same as `launchersSync`, without blocking; wakes the machine if asked. */
  async launchers(options: { wake?: boolean; signal?: AbortSignal } = {}): Promise<Record<string, RemoteLauncherInfo> | null> {
    if (this.list && Date.now() - this.list.at < LIST_TTL_MS) return this.list.launchers;
    try {
      const result = await this.run(['list-json'], { wake: options.wake ?? false, signal: options.signal });
      return this.storeList(result.code, result.stdout);
    } catch (err) {
      if (err instanceof RemoteUnreachableError && !options.wake) return null;
      throw err;
    }
  }

  /** Last list seen, even old: the ports do not change, so it still gives the URLs while the machine sleeps. */
  cachedLaunchers(): Record<string, RemoteLauncherInfo> | null {
    if (this.list) return this.list.launchers;
    if (!existsSync(this.cacheFile)) return null;
    try {
      return JSON.parse(readFileSync(this.cacheFile, 'utf-8')) as Record<string, RemoteLauncherInfo>;
    } catch {
      return null;
    }
  }

  private storeList(code: number | null, stdout: string): Record<string, RemoteLauncherInfo> | null {
    if (code !== 0) {
      this.unreachableAt = Date.now();
      return null;
    }
    const launchers = JSON.parse(stdout) as Record<string, RemoteLauncherInfo>;
    this.list = { at: Date.now(), launchers };
    this.unreachableAt = undefined;
    try {
      writeFileSync(this.cacheFile, JSON.stringify(launchers));
    } catch {
      // The cache only helps; never fail because of it.
    }
    return launchers;
  }

  /** Forgets the cached list (after a start or a stop). */
  invalidate(): void {
    this.list = undefined;
  }

  /** Local port of a remote port: through the tunnel, remote port + `port_offset`. */
  localPort(remotePort: number): number {
    return remotePort + this.config.portOffset;
  }

  async start(remoteName: string, options: RemoteCallOptions & { restart?: boolean; noWait?: boolean; holder?: string }): Promise<void> {
    const args = [options.restart ? 'restart' : 'start', remoteName, '--json', ...this.callArgs(options)];
    if (options.noWait) args.push('--no-wait');
    try {
      await this.runChecked(args, { signal: options.signal, onEvent: this.waitForwarder(options.onWait), busyHolder: options.holder ?? 'stack' });
    } finally {
      this.invalidate();
    }
  }

  async stop(remoteName: string, options: RemoteCallOptions & { holder?: string } = {}): Promise<void> {
    try {
      await this.runChecked(['stop', remoteName, '--json', ...this.callArgs(options)], {
        wake: false,
        signal: options.signal,
        onEvent: this.waitForwarder(options.onWait),
        busyHolder: options.holder ?? 'stack',
      });
    } finally {
      this.invalidate();
    }
  }

  /** `inactive` when the machine cannot be reached; never wakes it. */
  async status(remoteName: string): Promise<LauncherStatus> {
    try {
      const result = await this.run(['status', remoteName, '--json'], { wake: false });
      const data = JSON.parse(result.stdout) as Record<string, { status: LauncherStatus }>;
      return data[remoteName]?.status ?? 'inactive';
    } catch {
      return 'inactive';
    }
  }

  /** The GPU queue of the remote machine; null when it cannot be reached (never wakes it). */
  async gpu(): Promise<GpuStatus | null> {
    try {
      const result = await this.run(['gpu', '--json'], { wake: false });
      return result.code === 0 ? reviveStatus(JSON.parse(result.stdout) as GpuStatus) : null;
    } catch {
      return null;
    }
  }

  /** Background (P2) jobs of the remote machine wait for their quiet time; at most every 10 s, never waits. */
  touch(): void {
    if (Date.now() - this.lastTouch < TOUCH_INTERVAL_MS) return;
    this.lastTouch = Date.now();
    Bun.spawn(this.argv(['gpu', 'touch']), { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  }

  /**
   * Takes the GPU lease of the remote machine (`stack lease` over ssh), starting `remoteName`
   * under it first if given. Holder shown there: `<this host>/<holder>`.
   */
  async lease(options: RemoteCallOptions & { holder: string; remoteName?: string }): Promise<RemoteLease> {
    try {
      return await this.leaseOnce(options);
    } catch (err) {
      if (!(err instanceof RemoteUnreachableError)) throw err;
      await this.wakeUp(options.signal, err.message);
      return this.leaseOnce(options);
    }
  }

  private async leaseOnce(options: RemoteCallOptions & { holder: string; remoteName?: string }): Promise<RemoteLease> {
    options.signal?.throwIfAborted();
    const holder = `${hostname()}/${options.holder}`;
    const args = ['lease', ...(options.remoteName ? [options.remoteName] : []), '--json', '--holder', holder, ...this.callArgs(options)];
    const proc = Bun.spawn(this.argv(args), { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    const stderrText = new Response(proc.stderr).text();
    const onAbort = () => proc.kill();
    options.signal?.addEventListener('abort', onAbort);

    const forward = this.waitForwarder(options.onWait);
    let lease: RemoteLease | undefined;
    let lastHolder: LeaseInfo | null = null;
    let settle!: { resolve: (lease: RemoteLease) => void; reject: (err: Error) => void };
    const granted = new Promise<RemoteLease>((resolve, reject) => (settle = { resolve, reject }));
    let sawEvent = false;

    void (async () => {
      try {
        for await (const line of readLines(proc.stdout)) {
          const [event] = parseEvents(line);
          if (!event) continue;
          sawEvent = true;
          if (lease) {
            lease.onEvent(event);
          } else if (event.event === 'waiting') {
            lastHolder = event.holder ?? null;
            forward?.(event);
          } else if (event.event === 'granted') {
            lease = new RemoteLease(this.name, event.id ?? '', holder, event.priority ?? options.priority ?? 1, proc);
            this.invalidate();
            settle.resolve(lease);
          } else if (event.event === 'error') {
            const message = event.message ?? 'lease refused';
            settle.reject(/gave up waiting/.test(message) ? new GpuBusyError(holder, { holder: lastHolder, waiting: [] }) : new Error(`${this.name}: ${message}`));
          }
        }
      } catch {
        // stdout closed abruptly: handled below with the exit code.
      }
      const code = await proc.exited;
      options.signal?.removeEventListener('abort', onAbort);
      if (lease) {
        lease.lost('ended (connection to the remote machine closed)');
      } else if (options.signal?.aborted) {
        settle.reject(options.signal.reason instanceof Error ? options.signal.reason : new Error('aborted'));
      } else if (code === SSH_UNREACHABLE && !sawEvent) {
        settle.reject(new RemoteUnreachableError(`${this.name} cannot be reached: ${(await stderrText).trim() || 'ssh failed'}`));
      } else {
        settle.reject(new Error(`${this.name}: stack lease ended before the grant: ${(await stderrText).trim() || `exit code ${code}`}`));
      }
    })();

    return granted;
  }

  /** The tunnel to a remote port, tracked like a service in the PID directory. */
  tunnelLauncher(remotePort: number): Launcher {
    const local = this.localPort(remotePort);
    const ssh = this.config.ssh as string;
    return {
      name: `tunnel.${this.name}.${remotePort}`,
      type: 'tunnel',
      description: `ssh tunnel 127.0.0.1:${local} -> ${this.name}:${remotePort}`,
      commandLine: [
        'ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3',
        `-L 127.0.0.1:${local}:127.0.0.1:${remotePort}`,
        shellQuote(ssh),
      ].join(' '),
      vramGb: 0,
      gpu: false,
      exclusive: false,
      stopTimeoutSeconds: 5,
    };
  }

  /**
   * Makes `http://127.0.0.1:<local port>` reach the remote port: starts the ssh tunnel if it is
   * not running, restarts it if it no longer answers. No-op with `tunnel = false`.
   */
  async ensureTunnel(remotePort: number): Promise<void> {
    if (!this.config.tunnel) return;
    const processes = this.options.processes;
    const tunnel = this.tunnelLauncher(remotePort);
    const local = this.localPort(remotePort);
    if (processes.isActive(tunnel)) {
      if (await portOpen(local)) return;
      await sleep(1000);
      if (await portOpen(local)) return;
      this.options.logger?.log(`Tunnel to ${this.name}:${remotePort} does not answer, restarting it...`);
      await processes.stop(tunnel);
    } else if (await portOpen(local)) {
      throw new Error(`Port ${local} is already used by another program: cannot open the tunnel to ${this.name}:${remotePort} (change port_offset)`);
    }

    this.options.logger?.log(`Opening tunnel 127.0.0.1:${local} -> ${this.name}:${remotePort}...`);
    const started = processes.start(tunnel);
    let exited = false;
    void started.exited.then(() => (exited = true));
    const deadline = Date.now() + TUNNEL_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await portOpen(local)) return;
      if (exited || !processes.isActive(tunnel)) break;
      await sleep(100);
    }
    await processes.stop(tunnel);
    const log = processes.logFile?.(tunnel);
    const tail = log && existsSync(log) ? readFileSync(log, 'utf-8').trim().split('\n').slice(-5).join('\n') : '';
    throw new Error(`Tunnel to ${this.name}:${remotePort} did not open${tail ? `:\n${tail}` : ''}`);
  }

  /** Stops the tunnels opened to this machine (the ports of its launchers seen so far). */
  async closeTunnels(): Promise<void> {
    if (!this.config.tunnel) return;
    const ports = new Set(Object.values(this.cachedLaunchers() ?? {}).flatMap((info) => (info.port === undefined ? [] : [info.port])));
    for (const port of ports) {
      const tunnel = this.tunnelLauncher(port);
      if (this.options.processes.isActive(tunnel)) {
        this.options.logger?.log(`Closing tunnel to ${this.name}:${port}...`);
        await this.options.processes.stop(tunnel);
      }
    }
  }

  private callArgs(options: RemoteCallOptions): string[] {
    const args: string[] = [];
    if (options.priority !== undefined) args.push('--priority', String(options.priority));
    if (options.maxWait !== undefined) args.push('--max-wait', String(options.maxWait / 1000));
    if (options.force) args.push('--force');
    return args;
  }

  private waitForwarder(onWait: RemoteCallOptions['onWait']): ((event: RemoteEvent) => void) | undefined {
    if (!onWait) return undefined;
    return (event) => {
      if (event.event === 'waiting') onWait(event.holder ?? null, { position: event.position ?? 0, reason: event.reason ?? 'turn' });
    };
  }
}
