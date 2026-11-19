import { AsyncLocalStorage } from 'node:async_hooks';
import { GpuLeaseLostError, InvalidLauncherError, ProcessExitedError } from './errors';
import { describeLease, formatDuration } from './GpuLock';
import type { GpuLease, GpuLock, GpuStatus, JobPriority, LeaseInfo, QueuePosition } from './GpuLock';
import { HealthChecker } from './HealthChecker';
import type { Launcher } from './Launcher';
import type { LauncherStatus } from './LauncherStatus';
import type { Logger } from './Logger';
import { readLastLines } from './logs';
import type { ProcessController, ProcessExit, StartedProcess } from './ProcessManager';
import { RemoteLease } from './RemoteHost';
import type { RemoteHost, RemoteLauncherInfo } from './RemoteHost';
import { sleep } from './sleep';

/** How long a launcher without health check must survive after start to be considered started. */
const STARTUP_GRACE_MS = 500;
const LOG_LINES_ON_FAILURE = 20;

function formatGb(value: number): string {
  return `${Number(value.toFixed(2))}GB`;
}

/** Starting or stopping it changes what holds the GPU, so it takes the GPU lease. */
function usesGpu(launcher: Launcher): boolean {
  return launcher.gpu || launcher.exclusive;
}

export interface StopOptions {
  /** GPU lease held by the caller. Without it, and outside `withLease`, the call takes one for its own duration. */
  lease?: GpuLease;
  /** Skips the GPU lease: acts even while another client holds the GPU (`--force`). */
  force?: boolean;
  /** Stops waiting for the GPU lease. */
  signal?: AbortSignal;
  /** Priority of the lease the call takes on its own (default 1). */
  priority?: JobPriority;
  /** Gives up waiting for the GPU lease after this long, with `GpuBusyError`. */
  maxWait?: number;
  /** Called while waiting for the GPU lease, each time the holder, the position or the reason changes. */
  onWait?: (holder: LeaseInfo | null, me: QueuePosition) => void;
}

export interface StartOptions extends StopOptions {
  /** Waits for the health check, or a short survival check without one (default: true). */
  wait?: boolean;
  /**
   * Stops waiting for the GPU lease or the health check. A process started by this call is
   * then stopped; a service that was already running is left alone.
   */
  signal?: AbortSignal;
}

export interface LeaseOptions {
  /** Free text shown to the other clients while they wait, and by `stack gpu`. */
  holder: string;
  /** 0: interactive (chat), 1: asked by the user, 2: background. Default 1. */
  priority?: JobPriority;
  /**
   * Launcher the job needs: started under the lease before the job runs, and used to run the
   * jobs of the same launcher in a row. For a launcher of another machine (`remote`), the lease
   * is taken on that machine.
   */
  launcher?: string;
  /**
   * False: `launcher` is not started under the lease; it only picks the machine whose GPU is
   * leased and groups the jobs. The job starts its services itself (to show their loading time),
   * and they use this lease. Default true.
   */
  start?: boolean;
  /** Quiet time to wait for after the last P0/P1 activity (default: 60 s for P2, none otherwise). */
  idleMs?: number;
  /** Gives up after this long, with `GpuBusyError`. 0 = only if the GPU can be had at once. */
  maxWait?: number;
  /** Leaves the queue. */
  signal?: AbortSignal;
  /** Called while waiting, each time the holder, the position or the reason changes. */
  onWait?: (holder: LeaseInfo | null, me: QueuePosition) => void;
}

export interface OrchestratorGpu {
  lock: GpuLock;
  /** Prefix of the holder text of the leases taken implicitly by start/stop, e.g. `stack` → `stack: start gemma`. */
  holder: string;
}

export class Orchestrator {
  private readonly remotes = new Map<string, RemoteHost>();
  /** The remote lease of the enclosing `withLease`, used by start/stop on that machine. */
  private readonly remoteLeaseContext = new AsyncLocalStorage<RemoteLease>();
  private readonly launchers = new Map<string, Launcher>();
  private readonly healthChecker: HealthChecker;

  constructor(
    private readonly process: ProcessController,
    /** No VRAM budget check when undefined. */
    private readonly vramCapacityGb: number | undefined,
    private readonly logger?: Logger,
    healthChecker?: HealthChecker,
    /** GPU lease shared with the other clients; without it, start/stop never wait. */
    private readonly gpu?: OrchestratorGpu,
  ) {
    this.healthChecker = healthChecker ?? new HealthChecker();
  }

  addLauncher(launcher: Launcher): void {
    this.launchers.set(launcher.name, launcher);
  }

  /** A machine whose services are driven over ssh: the launchers with `remote = <its name>`. */
  addRemote(host: RemoteHost): void {
    this.remotes.set(host.name, host);
  }

  getRemotes(): RemoteHost[] {
    return [...this.remotes.values()];
  }

  /**
   * Where a remote launcher runs and how to reach it: its info on the remote machine (fresh if
   * it answers, else the last one seen, never waking it), the local port and URL through the
   * tunnel. Null for a local launcher.
   */
  remoteInfo(name: string): { host: RemoteHost; remoteName: string; info?: RemoteLauncherInfo; fresh: boolean; port?: number; url?: string } | null {
    const launcher = this.getLauncher(name);
    if (launcher.remote === undefined) return null;
    const { host, remoteName } = this.remoteOf(launcher);
    const fresh = host.launchersSync();
    const info = (fresh ?? host.cachedLaunchers())?.[remoteName];
    const port = info?.port === undefined ? undefined : host.localPort(info.port);
    return { host, remoteName, info, fresh: fresh !== null, port, url: port === undefined ? undefined : `http://127.0.0.1:${port}` };
  }

  getLaunchers(): Launcher[] {
    return [...this.launchers.values()];
  }

  getLauncher(name: string): Launcher {
    const launcher = this.launchers.get(name);
    if (!launcher) {
      throw new InvalidLauncherError(`invalid launcher: ${name}`);
    }

    return launcher;
  }

  async ensureActive(name: string, options: StartOptions = {}): Promise<void> {
    const launcher = this.getLauncher(name);
    if (launcher.remote !== undefined) {
      return this.remoteStart(launcher, options, false);
    }
    const wait = options.wait ?? true;

    if (this.process.isActive(launcher)) {
      if (wait && launcher.health) {
        await this.waitForHealth(launcher, () => this.process.isActive(launcher), options.signal);
      }
      return;
    }

    await this.withGpu(`start ${name}`, usesGpu(launcher), { ...options, launcher: name }, async () => {
      // Another client may have started it while we waited for the GPU.
      if (this.process.isActive(launcher)) {
        if (wait && launcher.health) {
          await this.waitForHealth(launcher, () => this.process.isActive(launcher), options.signal);
        }
        return;
      }

      const toStop = launcher.exclusive
        ? this.activeLaunchers().filter((other) => other.name !== name && other.exclusive)
        : [];
      // Checked before stopping anything, so a refused start leaves the stack untouched.
      this.assertFitsInVram(launcher, toStop);

      for (const other of toStop) {
        this.logger?.log(`Stopping ${other.name} (exclusive)...`);
        await this.process.stop(other);
      }
      options.signal?.throwIfAborted();

      this.logger?.log(`Starting ${name}...`);
      const started = this.process.start(launcher);
      const logFile = this.process.logFile?.(launcher);
      this.logger?.log(`  pid ${started.pid}${logFile ? `, log: ${logFile}` : ''}`);

      if (!wait) {
        return;
      }
      try {
        await this.waitForStartup(launcher, started, options.signal);
      } catch (err) {
        if (options.signal?.aborted && this.process.isActive(launcher)) {
          this.logger?.log(`Start of ${name} cancelled, stopping it...`);
          await this.process.stop(launcher);
        }
        throw err;
      }
    });
  }

  /** Stop then start, under a single GPU lease: no other client can take the GPU in between. */
  async restart(name: string, options: StartOptions = {}): Promise<void> {
    const launcher = this.getLauncher(name);
    if (launcher.remote !== undefined) {
      return this.remoteStart(launcher, options, true);
    }
    await this.withGpu(`restart ${name}`, usesGpu(launcher), { ...options, launcher: name }, async () => {
      await this.stopLauncher(launcher);
      await this.ensureActive(name, options);
    });
  }

  /** For a remote launcher, asks the remote machine (synchronously, never waking it; false if it does not answer). */
  isLauncherActive(name: string): boolean {
    const launcher = this.getLauncher(name);
    if (launcher.remote !== undefined) {
      const { host, remoteName } = this.remoteOf(launcher);
      return host.launchersSync()?.[remoteName]?.active ?? false;
    }
    return this.process.isActive(launcher);
  }

  /** Null for a remote launcher. */
  getLauncherPid(name: string): number | null {
    const launcher = this.getLauncher(name);
    return launcher.remote === undefined ? this.process.getPid(launcher) : null;
  }

  /** Undefined for a remote launcher (its log is on the remote machine: `stack logs` fetches it). */
  getLauncherLogFile(name: string): string | undefined {
    const launcher = this.getLauncher(name);
    return launcher.remote === undefined ? this.process.logFile?.(launcher) : undefined;
  }

  async getLauncherStatus(name: string): Promise<LauncherStatus> {
    const launcher = this.getLauncher(name);
    if (launcher.remote !== undefined) {
      const { host, remoteName } = this.remoteOf(launcher);
      return host.status(remoteName);
    }

    if (!this.process.isActive(launcher)) {
      return 'inactive';
    }

    if (!launcher.health || (await this.healthChecker.isHealthy(launcher.health))) {
      return 'ready';
    }

    return 'starting';
  }

  async stop(name: string, options: StopOptions = {}): Promise<void> {
    const launcher = this.getLauncher(name);
    if (launcher.remote !== undefined) {
      return this.remoteStop(launcher, options);
    }
    if (!this.process.isActive(launcher)) {
      return;
    }

    await this.withGpu(`stop ${name}`, usesGpu(launcher), options, () => this.stopLauncher(launcher));
  }

  /**
   * Stops the local services and closes the tunnels to the remote machines. The services of a
   * remote machine keep running: they are shared with its own clients.
   */
  async stopAll(options: StopOptions = {}): Promise<void> {
    for (const host of this.remotes.values()) {
      await host.closeTunnels();
    }
    const active = this.activeLaunchers();
    if (active.length === 0) {
      return;
    }

    await this.withGpu('stop all', active.some(usesGpu), options, async () => {
      for (const launcher of this.launchers.values()) {
        await this.stopLauncher(launcher);
      }
    });
  }

  /**
   * Waits for the GPU, logging who holds it meanwhile. The caller must `release()` the lease;
   * prefer `withLease`, which does it.
   */
  async acquireLease(options: LeaseOptions): Promise<GpuLease> {
    const remote = options.launcher === undefined ? undefined : this.getLauncher(options.launcher).remote;
    if (remote !== undefined) {
      return this.acquireRemoteLease(options);
    }
    const waited = this.waitLogger(options.onWait);
    const lease = await this.requireGpu().lock.acquire({ ...options, onWait: waited.onWait });
    waited.acquired();
    try {
      await this.startJobLauncher(lease, options);
    } catch (err) {
      lease.release();
      throw err;
    }
    return lease;
  }

  /**
   * Runs `fn` holding the GPU, then releases it. Inside `fn`, start/stop use this lease instead
   * of taking their own, and a nested `withLease` reuses it.
   */
  async withLease<T>(options: LeaseOptions, fn: (lease: GpuLease) => Promise<T>): Promise<T> {
    const launcher = options.launcher === undefined ? undefined : this.getLauncher(options.launcher);
    if (launcher?.remote !== undefined) {
      const { host, remoteName } = this.remoteOf(launcher);
      const current = this.remoteLeaseFor(host.name);
      if (current?.held) {
        if (options.start !== false) {
          await current.command(`start ${remoteName}`);
          host.invalidate();
          await this.openTunnel(host, remoteName);
        }
        return fn(current);
      }
      const lease = await this.acquireRemoteLease(options);
      try {
        return await this.remoteLeaseContext.run(lease, () => fn(lease));
      } finally {
        lease.release();
        // Returns once the remote machine has let go, like a local lease.
        await lease.closed();
      }
    }
    const waited = this.waitLogger(options.onWait);
    return this.requireGpu().lock.withLease({ ...options, onWait: waited.onWait }, async (lease) => {
      waited.acquired();
      await this.startJobLauncher(lease, options);
      return fn(lease);
    });
  }

  /** Marks the GPU as in use: background (P2) jobs wait for their quiet time from now. */
  touchGpu(): void {
    this.requireGpu().lock.touch();
    for (const host of this.remotes.values()) host.touch();
  }

  /** The GPU queue of each remote machine (null when it does not answer; never wakes it). */
  async remoteLeaseStatus(): Promise<Record<string, GpuStatus | null>> {
    const hosts = [...this.remotes.values()];
    const statuses = await Promise.all(hosts.map((host) => host.gpu()));
    return Object.fromEntries(hosts.map((host, i) => [host.name, statuses[i] ?? null]));
  }

  /** Removes a waiting client from the GPU queue (`stack gpu cancel <id>`); null if it was not waiting. */
  cancelLeaseRequest(id: string): LeaseInfo | null {
    return this.requireGpu().lock.cancel(id);
  }

  /** Who holds the GPU and who waits; null without a GPU lock. */
  leaseStatus(): GpuStatus | null {
    return this.gpu?.lock.status() ?? null;
  }

  /** Breaks the current lease (`stack gpu release --force`) and returns it, or null if the GPU was free. */
  breakLease(): LeaseInfo | null {
    return this.requireGpu().lock.forceRelease();
  }

  async checkSMI(): Promise<string> {
    try {
      const proc = Bun.spawn(['nvidia-smi'], { stdout: 'pipe', stderr: 'ignore' });
      return await new Response(proc.stdout).text();
    } catch {
      return '';
    }
  }

  private async stopLauncher(launcher: Launcher): Promise<void> {
    if (launcher.remote !== undefined || !this.process.isActive(launcher)) {
      return;
    }

    this.logger?.log(`Stopping ${launcher.name}...`);
    await this.process.stop(launcher);
  }

  /** Runs `fn` under the caller's lease, the enclosing `withLease`, or a lease taken for its duration. */
  private async withGpu<T>(
    action: string,
    needed: boolean,
    options: StopOptions & { launcher?: string },
    fn: () => Promise<T>,
  ): Promise<T> {
    const gpu = this.gpu;
    if (!needed || options.force || gpu === undefined) {
      return fn();
    }

    // A lease of another machine says nothing about this one's GPU.
    const lease = (options.lease instanceof RemoteLease ? undefined : options.lease) ?? gpu.lock.currentLease();
    if (lease !== undefined) {
      if (!lease.held) {
        throw new GpuLeaseLostError(`GPU lease of ${lease.holder} is no longer held (released, or broken by another client)`);
      }
      return fn();
    }

    const { signal, priority, maxWait, onWait, launcher } = options;
    const waited = this.waitLogger(onWait);
    return gpu.lock.withLease({ holder: `${gpu.holder}: ${action}`, signal, priority, maxWait, launcher, onWait: waited.onWait }, () => {
      waited.acquired();
      return fn();
    });
  }

  private requireGpu(): OrchestratorGpu {
    if (this.gpu === undefined) {
      throw new Error('No GPU lock configured');
    }
    return this.gpu;
  }

  /** Starts the launcher a job asked for, under its lease. */
  private async startJobLauncher(lease: GpuLease, options: LeaseOptions): Promise<void> {
    if (options.launcher !== undefined && options.start !== false) {
      await this.ensureActive(options.launcher, { lease, signal: options.signal });
    }
  }

  /** Logs who holds the GPU while waiting, then how long the wait took; forwards to the caller's `onWait`. */
  private waitLogger(callerOnWait?: LeaseOptions['onWait']): {
    onWait: (holder: LeaseInfo | null, me: QueuePosition) => void;
    acquired: () => void;
  } {
    let waitingSince: number | undefined;
    return {
      onWait: (holder, me) => {
        waitingSince ??= Date.now();
        const why = me.reason === 'idle' ? ' (waiting for the GPU to be idle)' : me.position > 0 ? ` (${me.position} ahead)` : '';
        this.logger?.log(`${holder === null ? 'GPU busy' : `GPU held by ${describeLease(holder)}`}, waiting${why}...`);
        callerOnWait?.(holder, me);
      },
      acquired: () => {
        if (waitingSince !== undefined) {
          this.logger?.log(`GPU acquired after ${formatDuration(Date.now() - waitingSince)}.`);
        }
      },
    };
  }

  private activeLaunchers(): Launcher[] {
    return [...this.launchers.values()].filter((launcher) => launcher.remote === undefined && this.process.isActive(launcher));
  }

  private remoteOf(launcher: Launcher): { host: RemoteHost; remoteName: string } {
    const remote = launcher.remote;
    const host = remote === undefined ? undefined : this.remotes.get(remote.host);
    if (remote === undefined || host === undefined) {
      throw new InvalidLauncherError(`${launcher.name}: remote machine '${remote?.host}' is not configured`);
    }
    return { host, remoteName: remote.name };
  }

  /** The lease of that machine given by the caller, or held by the enclosing `withLease`. */
  private remoteLeaseFor(hostName: string, explicit?: GpuLease): RemoteLease | undefined {
    if (explicit instanceof RemoteLease && explicit.remote === hostName) return explicit;
    const current = this.remoteLeaseContext.getStore();
    return current?.remote === hostName ? current : undefined;
  }

  /** Start (or restart) on the remote machine: under the caller's lease of that machine, or with its own lease there. */
  private async remoteStart(launcher: Launcher, options: StartOptions, restart: boolean): Promise<void> {
    const { host, remoteName } = this.remoteOf(launcher);
    const lease = this.remoteLeaseFor(host.name, options.lease);
    if (lease !== undefined) {
      if (!lease.held) {
        throw new GpuLeaseLostError(`GPU lease of ${lease.holder} on ${host.name} is no longer held`);
      }
      try {
        await lease.command(`${restart ? 'restart' : 'start'} ${remoteName}`);
      } finally {
        host.invalidate();
      }
    } else {
      const waited = this.waitLogger(options.onWait);
      this.logger?.log(`${restart ? 'Restarting' : 'Starting'} ${launcher.name} on ${host.name}...`);
      await host.start(remoteName, {
        restart,
        noWait: options.wait === false,
        force: options.force,
        priority: options.priority,
        maxWait: options.maxWait,
        signal: options.signal,
        onWait: waited.onWait,
        holder: `${this.gpu?.holder ?? 'stack'}: start ${launcher.name}`,
      });
      waited.acquired();
    }
    await this.openTunnel(host, remoteName, options.signal);
  }

  private async remoteStop(launcher: Launcher, options: StopOptions): Promise<void> {
    const { host, remoteName } = this.remoteOf(launcher);
    const lease = this.remoteLeaseFor(host.name, options.lease);
    if (lease !== undefined) {
      try {
        await lease.command(`stop ${remoteName}`);
      } finally {
        host.invalidate();
      }
      return;
    }
    this.logger?.log(`Stopping ${launcher.name} on ${host.name}...`);
    await host.stop(remoteName, {
      force: options.force,
      priority: options.priority,
      maxWait: options.maxWait,
      signal: options.signal,
      onWait: this.waitLogger(options.onWait).onWait,
      holder: `${this.gpu?.holder ?? 'stack'}: stop ${launcher.name}`,
    });
  }

  private async acquireRemoteLease(options: LeaseOptions): Promise<RemoteLease> {
    const { host, remoteName } = this.remoteOf(this.getLauncher(options.launcher as string));
    const waited = this.waitLogger(options.onWait);
    const start = options.start !== false;
    const lease = await host.lease({
      holder: options.holder,
      remoteName: start ? remoteName : undefined,
      priority: options.priority,
      maxWait: options.maxWait,
      signal: options.signal,
      onWait: waited.onWait,
    });
    waited.acquired();
    if (!start) {
      return lease;
    }
    try {
      await this.openTunnel(host, remoteName, options.signal);
    } catch (err) {
      lease.release();
      throw err;
    }
    return lease;
  }

  /** Opens the tunnel to the port of a remote launcher (none for a service without port). */
  private async openTunnel(host: RemoteHost, remoteName: string, signal?: AbortSignal): Promise<void> {
    const launchers = (await host.launchers({ signal })) ?? host.cachedLaunchers();
    const info = launchers?.[remoteName];
    if (launchers !== null && info === undefined) {
      throw new InvalidLauncherError(`${remoteName} is not a launcher of ${host.name}`);
    }
    if (info?.port !== undefined) {
      await host.ensureTunnel(info.port);
    }
  }

  /** Waits for a freshly started process: health check if configured, otherwise a short survival check. */
  private async waitForStartup(launcher: Launcher, started: StartedProcess, signal?: AbortSignal): Promise<void> {
    let exit: ProcessExit | undefined;
    void started.exited.then((result) => {
      exit = result;
    });
    const isAlive = () => exit === undefined && this.process.isActive(launcher);

    try {
      if (launcher.health) {
        await this.waitForHealth(launcher, isAlive, signal);
      } else {
        await sleep(STARTUP_GRACE_MS, signal);
        if (!isAlive()) {
          throw new ProcessExitedError('Process exited right after start');
        }
      }
    } catch (err) {
      if (signal?.aborted) {
        throw err;
      }
      if (!(err instanceof ProcessExitedError)) {
        throw new Error(this.withLogTail(launcher, err instanceof Error ? err.message : String(err)));
      }
      // The exit may be observed through /proc slightly before the promise settles.
      exit ??= await Promise.race([started.exited, Bun.sleep(500).then(() => undefined)]);
      throw new ProcessExitedError(this.withLogTail(launcher, `${launcher.name} ${this.describeExit(exit)} before becoming ready`));
    }
  }

  private async waitForHealth(launcher: Launcher, isAlive: () => boolean, signal?: AbortSignal): Promise<void> {
    const health = launcher.health;
    if (!health) {
      return;
    }

    this.logger?.log(`Waiting for ${launcher.name} to become healthy (${health.url})...`);
    await this.healthChecker.waitUntilHealthy(health, isAlive, signal);
    this.logger?.log(`${launcher.name} is healthy.`);
  }

  private describeExit(exit: ProcessExit | undefined): string {
    if (exit?.signal) {
      return `was killed by ${exit.signal}`;
    }
    if (exit?.code !== undefined && exit.code !== null) {
      return `exited with code ${exit.code}`;
    }
    return 'exited';
  }

  private withLogTail(launcher: Launcher, message: string): string {
    const logFile = this.process.logFile?.(launcher);
    if (!logFile) {
      return message;
    }

    const lines = readLastLines(logFile, LOG_LINES_ON_FAILURE);
    if (lines.length === 0) {
      return `${message}\nLog file is empty: ${logFile}`;
    }
    return `${message}\nLast lines of ${logFile}:\n${lines.map((line) => `  | ${line}`).join('\n')}`;
  }

  private assertFitsInVram(launcher: Launcher, stopping: Launcher[]): void {
    if (!launcher.gpu || this.vramCapacityGb === undefined) {
      return;
    }

    const users = this.activeLaunchers().filter(
      (other) => other.gpu && other.name !== launcher.name && !stopping.includes(other),
    );
    const usedByOthers = users.reduce((sum, other) => sum + other.vramGb, 0);

    if (usedByOthers + launcher.vramGb > this.vramCapacityGb) {
      const usedBy = users.length > 0 ? `, ${formatGb(usedByOthers)} used by ${users.map((u) => u.name).join(', ')}` : '';
      throw new Error(
        `Not enough VRAM for ${launcher.name}: needs ${formatGb(launcher.vramGb)}${usedBy} (capacity ${formatGb(this.vramCapacityGb)})`,
      );
    }
  }
}
