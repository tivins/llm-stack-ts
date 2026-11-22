import { statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { Args } from './args';
import { loadStackConfig, resolveStackFile } from './config';
import type { ConfigWarning, StackConfig } from './config';
import { defaultGpuJournalDir } from './GpuJournal';
import { GpuLock } from './GpuLock';
import type { GpuLease, GpuStatus, LeaseInfo } from './GpuLock';
import type { Launcher } from './Launcher';
import type { LauncherStatus } from './LauncherStatus';
import type { Logger } from './Logger';
import { Orchestrator } from './Orchestrator';
import type { LeaseOptions, StartOptions, StopOptions } from './Orchestrator';
import { ProcessManager } from './ProcessManager';
import { RemoteHost } from './RemoteHost';

export interface StackOptions {
  /** Explicit path to the stack file. Falls back to $LLM_STACK_CONFIG, then ./stack.toml, then ./stack.json. */
  file?: string;
  /** Extra args per launcher name, merged over the configuration (same as `stack start <name> --arg ...`). */
  argOverrides?: Record<string, Args>;
  /** Receives progress messages (starting, waiting for the GPU, healthy...). Silent when omitted; pass `new ConsoleLogger()` to print them. */
  logger?: Logger;
  /** Directory used for PID files. Defaults to <tmpdir>/stack-llm. */
  pidDir?: string;
  /** Directory receiving each launcher's stdout/stderr. Defaults to $XDG_STATE_HOME/llm-stack/logs. */
  logDir?: string;
  /** Directory of the journal of the GPU leases (`stack gpu history`). Defaults to $XDG_STATE_HOME/llm-stack/gpu-journal. */
  gpuJournalDir?: string;
  /**
   * Prefix of the holder text of the GPU leases that start/stop take on their own, shown to the
   * other clients while they wait (`persona_helper` → `persona_helper: start comfyui`).
   * Defaults to the script name.
   */
  holder?: string;
}

export interface StackStartOptions extends Omit<StartOptions, 'wait'> {
  /** Returns once the process is spawned, without waiting for the health check. */
  noWait?: boolean;
}

export interface LauncherSummary {
  readonly name: string;
  readonly type: string;
  readonly description: string;
  readonly active: boolean;
  /** VRAM budget in GB. */
  readonly size: number;
  readonly gpu: boolean;
  readonly exclusive: boolean;
  /** Parent launcher (`extends`), possibly an abstract one. */
  readonly extends?: string;
  /** `args.model` (llama-server model file). */
  readonly model?: string;
  /** `args.ctx-size`. */
  readonly ctxSize?: number;
  /** `args.reasoning-budget` (-1 = unlimited). */
  readonly reasoningBudget?: number;
  /** Local port: for a remote launcher, the end of the ssh tunnel (remote port + `port_offset`). */
  readonly port?: number;
  /**
   * Base URL of the service, to give to a client (`new LLM(summary.url)`): the origin of the
   * health check, or `http://127.0.0.1:<port>`; for a remote launcher, the local end of the
   * tunnel, opened by `start`. Undefined without a port (or a remote machine never reached).
   */
  readonly url?: string;
  /** Name of the remote machine (`remote = "forge"`); undefined for a local launcher. */
  readonly host?: string;
}

/** The fields of `LauncherSummary` taken from the launcher itself (everything but `active`). */
export function summarizeLauncher(launcher: Launcher): Omit<LauncherSummary, 'active'> {
  const model = launcher.args?.model;
  const numeric = (key: string) => {
    const value = launcher.args?.[key];
    return typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
      ? Number(value)
      : undefined;
  };
  return {
    name: launcher.name,
    type: launcher.type,
    description: launcher.description,
    size: launcher.vramGb,
    gpu: launcher.gpu,
    exclusive: launcher.exclusive,
    extends: launcher.extends,
    model: typeof model === 'string' ? model : undefined,
    ctxSize: numeric('ctx-size'),
    reasoningBudget: numeric('reasoning-budget'),
    port: launcher.port ?? healthPort(launcher),
    url: serviceUrl(launcher),
  };
}

/** Port of the health check URL, for a launcher without `port` (ComfyUI started with its default port). */
function healthPort(launcher: Launcher): number | undefined {
  const url = launcher.health?.url;
  if (url === undefined || !URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  const port = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port);
  return Number.isInteger(port) ? port : undefined;
}

/** Origin of the health check, else `http://127.0.0.1:<port>`. */
function serviceUrl(launcher: Launcher): string | undefined {
  if (launcher.health?.url) {
    try {
      return new URL(launcher.health.url).origin;
    } catch {
      // Not a URL we can use: fall back to the port.
    }
  }
  return launcher.port === undefined ? undefined : `http://127.0.0.1:${launcher.port}`;
}

/**
 * Summary of a launcher as seen from here: for a remote launcher, its model, VRAM and state
 * come from the remote machine (never woken up; last known values if it does not answer),
 * and `port` / `url` are the local end of the tunnel.
 */
export function describeLauncher(orchestrator: Orchestrator, launcher: Launcher): LauncherSummary {
  const remote = orchestrator.remoteInfo(launcher.name);
  if (remote === null) {
    return { ...summarizeLauncher(launcher), active: orchestrator.isLauncherActive(launcher.name) };
  }
  const info = remote.info;
  return {
    name: launcher.name,
    type: launcher.type || info?.type || '',
    description: launcher.description || info?.description || '',
    active: remote.fresh ? (info?.active ?? false) : false,
    size: info?.size ?? 0,
    gpu: info?.gpu ?? false,
    exclusive: info?.exclusive ?? false,
    model: info?.model,
    ctxSize: info?.ctxSize,
    reasoningBudget: info?.reasoningBudget,
    port: remote.port,
    url: remote.url,
    host: remote.host.name,
  };
}

export function defaultPidDir(): string {
  return path.join(tmpdir(), 'stack-llm');
}

/** The GPU lease lives next to the PID files: clients that see the same services share it. */
export function gpuLockDir(pidDir: string): string {
  return path.join(pidDir, 'gpu');
}

export function defaultLogDir(): string {
  const stateHome = process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state');
  return path.join(stateHome, 'llm-stack', 'logs');
}

/** Builds an orchestrator wired to real processes, as used by both the CLI and `Stack`. */
export function createOrchestrator(config: StackConfig, options: Omit<StackOptions, 'file' | 'argOverrides'> = {}): Orchestrator {
  const pidDir = options.pidDir ?? defaultPidDir();
  const processManager = new ProcessManager(pidDir, options.logger, options.logDir ?? defaultLogDir());
  const orchestrator = new Orchestrator(processManager, config.vramCapacityGb, options.logger, undefined, {
    lock: new GpuLock(gpuLockDir(pidDir), { ...config.gpuQueue, journalDir: options.gpuJournalDir ?? defaultGpuJournalDir() }),
    holder: options.holder ?? path.basename(process.argv[1] ?? 'bun'),
  });
  for (const launcher of config.launchers) {
    orchestrator.addLauncher(launcher);
  }
  for (const remote of config.remotes) {
    orchestrator.addRemote(new RemoteHost(remote, { pidDir, processes: processManager, logger: options.logger }));
  }
  return orchestrator;
}

/**
 * High-level entry point for controlling the stack programmatically,
 * e.g. `new Stack().start('llm_main')`. Same orchestration logic as the
 * `stack` CLI (src/cli.ts), just imported directly instead of shelled out to.
 */
export class Stack {
  private readonly orchestrator: Orchestrator;
  private readonly file: string;
  private readonly options: StackOptions;
  /** Modification time of the stack file when it was last read. */
  private fileMtimeMs: number | undefined;
  private configWarnings: readonly ConfigWarning[];

  constructor(options: StackOptions = {}) {
    this.options = options;
    this.file = resolveStackFile(options.file, import.meta.dir);
    this.fileMtimeMs = mtimeMs(this.file);
    const config = loadStackConfig(this.file, { argOverrides: options.argOverrides });
    this.configWarnings = config.warnings;
    this.orchestrator = createOrchestrator(config, options);
  }

  /** Non-fatal issues found in the configuration file (unknown keys, deprecated keys). */
  get warnings(): readonly ConfigWarning[] {
    this.refresh();
    return this.configWarnings;
  }

  /**
   * Reads the stack file again when it changed since the last read, so that a long-running
   * process sees the launchers added since it started: an exclusive start then stops them.
   * The `[remotes]` table is not read again. A file that no longer parses keeps the previous
   * launchers (with a message to the logger) until it changes again.
   */
  private refresh(): void {
    const current = mtimeMs(this.file);
    if (current === undefined || current === this.fileMtimeMs) return;
    this.fileMtimeMs = current;
    try {
      const config = loadStackConfig(this.file, { argOverrides: this.options.argOverrides });
      this.orchestrator.replaceLaunchers(config.launchers);
      this.configWarnings = config.warnings;
      this.options.logger?.log(`Reloaded ${this.file}`);
    } catch (err) {
      this.options.logger?.log(`Kept the previous launchers, ${this.file} does not load: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  list(): Launcher[] {
    this.refresh();
    return this.orchestrator.getLaunchers();
  }

  listSummary(): Record<string, LauncherSummary> {
    this.refresh();
    const summary: Record<string, LauncherSummary> = {};
    for (const launcher of this.orchestrator.getLaunchers()) {
      summary[launcher.name] = describeLauncher(this.orchestrator, launcher);
    }
    return summary;
  }

  /**
   * Starts the service and waits for its health check. A GPU service waits for the GPU lease
   * when another client holds it (unless `lease`, `force`, or inside `withLease`).
   */
  async start(name: string, options: StackStartOptions = {}): Promise<void> {
    this.refresh();
    await this.orchestrator.ensureActive(name, { ...options, wait: !options.noWait });
  }

  async restart(name: string, options: StackStartOptions = {}): Promise<void> {
    this.refresh();
    await this.orchestrator.restart(name, { ...options, wait: !options.noWait });
  }

  /** Resolves once the process has exited. */
  async stop(name: string, options: StopOptions = {}): Promise<void> {
    this.refresh();
    await this.orchestrator.stop(name, options);
  }

  async stopAll(options: StopOptions = {}): Promise<void> {
    this.refresh();
    await this.orchestrator.stopAll(options);
  }

  /**
   * Runs `fn` holding the GPU lease, then releases it, even on error. No other client of the
   * stack can start or stop a GPU service meanwhile; start/stop inside `fn` use this lease.
   * The lease is a job in the GPU queue: `priority` (0 chat, 1 asked by the user, 2 background),
   * `launcher` (started before `fn`, and jobs for the loaded launcher run in a row), `maxWait`.
   */
  async withLease<T>(options: LeaseOptions, fn: (lease: GpuLease) => Promise<T>): Promise<T> {
    this.refresh();
    return this.orchestrator.withLease(options, fn);
  }

  /** Waits for the GPU lease. Release it with `lease.release()`; pass it to start/stop as `{ lease }`. */
  async acquire(options: LeaseOptions): Promise<GpuLease> {
    this.refresh();
    return this.orchestrator.acquireLease(options);
  }

  /** Who holds the GPU lease, and who waits for it, in the order they will get it. Local GPU only: see `remoteGpu()`. */
  gpu(): GpuStatus {
    return this.orchestrator.leaseStatus() ?? { holder: null, waiting: [] };
  }

  /** The GPU queue of each remote machine, by name (null when it does not answer; never wakes it). */
  async remoteGpu(): Promise<Record<string, GpuStatus | null>> {
    return this.orchestrator.remoteLeaseStatus();
  }

  /**
   * Marks the GPU as in use (e.g. the user is typing): background (P2) jobs wait for their quiet
   * time from now. Also on the remote machines, at most every 10 s, without waiting for them.
   */
  touch(): void {
    this.orchestrator.touchGpu();
  }

  /** Removes a waiting job from the GPU queue, from any process: its `acquire` rejects with `GpuLeaseLostError`. */
  cancel(id: string): LeaseInfo | null {
    return this.orchestrator.cancelLeaseRequest(id);
  }

  async status(name: string): Promise<LauncherStatus> {
    this.refresh();
    return this.orchestrator.getLauncherStatus(name);
  }

  isActive(name: string): boolean {
    this.refresh();
    return this.orchestrator.isLauncherActive(name);
  }

  pid(name: string): number | null {
    this.refresh();
    return this.orchestrator.getLauncherPid(name);
  }

  /** Path of the file receiving the launcher's stdout/stderr. */
  logFile(name: string): string | undefined {
    this.refresh();
    return this.orchestrator.getLauncherLogFile(name);
  }
}

function mtimeMs(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}
