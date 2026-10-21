import { GpuLeaseLostError, InvalidLauncherError, ProcessExitedError } from './errors';
import { describeLease, formatDuration } from './GpuLock';
import type { GpuLease, GpuLock, GpuStatus, JobPriority, LeaseInfo, QueuePosition } from './GpuLock';
import { HealthChecker } from './HealthChecker';
import type { Launcher } from './Launcher';
import type { LauncherStatus } from './LauncherStatus';
import type { Logger } from './Logger';
import { readLastLines } from './logs';
import type { ProcessController, ProcessExit, StartedProcess } from './ProcessManager';
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
   * jobs of the same launcher in a row.
   */
  launcher?: string;
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
    await this.withGpu(`restart ${name}`, usesGpu(launcher), { ...options, launcher: name }, async () => {
      await this.stopLauncher(launcher);
      await this.ensureActive(name, options);
    });
  }

  isLauncherActive(name: string): boolean {
    return this.process.isActive(this.getLauncher(name));
  }

  getLauncherPid(name: string): number | null {
    return this.process.getPid(this.getLauncher(name));
  }

  getLauncherLogFile(name: string): string | undefined {
    return this.process.logFile?.(this.getLauncher(name));
  }

  async getLauncherStatus(name: string): Promise<LauncherStatus> {
    const launcher = this.getLauncher(name);

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
    if (!this.process.isActive(launcher)) {
      return;
    }

    await this.withGpu(`stop ${name}`, usesGpu(launcher), options, () => this.stopLauncher(launcher));
  }

  async stopAll(options: StopOptions = {}): Promise<void> {
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
    if (!this.process.isActive(launcher)) {
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

    const lease = options.lease ?? gpu.lock.currentLease();
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
    if (options.launcher !== undefined) {
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
    return [...this.launchers.values()].filter((launcher) => this.process.isActive(launcher));
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
