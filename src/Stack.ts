import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { Args } from './args';
import { loadStackConfig, resolveStackFile } from './config';
import type { ConfigWarning, StackConfig } from './config';
import type { Launcher } from './Launcher';
import type { LauncherStatus } from './LauncherStatus';
import { ConsoleLogger } from './Logger';
import type { Logger } from './Logger';
import { Orchestrator } from './Orchestrator';
import { ProcessManager } from './ProcessManager';

export interface StackOptions {
  /** Explicit path to the stack file. Falls back to $LLM_STACK_CONFIG, then ./stack.toml, then ./stack.json. */
  file?: string;
  /** Extra args per launcher name, merged over the configuration (same as `stack start <name> --arg ...`). */
  argOverrides?: Record<string, Args>;
  logger?: Logger;
  /** Directory used for PID files. Defaults to <tmpdir>/stack-llm. */
  pidDir?: string;
  /** Directory receiving each launcher's stdout/stderr. Defaults to $XDG_STATE_HOME/llm-stack/logs. */
  logDir?: string;
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
  readonly port?: number;
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
    port: launcher.port,
  };
}

export function defaultPidDir(): string {
  return path.join(tmpdir(), 'stack-llm');
}

export function defaultLogDir(): string {
  const stateHome = process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state');
  return path.join(stateHome, 'llm-stack', 'logs');
}

/** Builds an orchestrator wired to real processes, as used by both the CLI and `Stack`. */
export function createOrchestrator(config: StackConfig, options: Omit<StackOptions, 'file' | 'argOverrides'> = {}): Orchestrator {
  const logger = options.logger ?? new ConsoleLogger();
  const processManager = new ProcessManager(options.pidDir ?? defaultPidDir(), logger, options.logDir ?? defaultLogDir());
  const orchestrator = new Orchestrator(processManager, config.vramCapacityGb, logger);
  for (const launcher of config.launchers) {
    orchestrator.addLauncher(launcher);
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
  /** Non-fatal issues found in the configuration file (unknown keys, deprecated keys). */
  readonly warnings: readonly ConfigWarning[];

  constructor(options: StackOptions = {}) {
    const config = loadStackConfig(resolveStackFile(options.file, import.meta.dir), { argOverrides: options.argOverrides });
    this.warnings = config.warnings;
    this.orchestrator = createOrchestrator(config, options);
  }

  list(): Launcher[] {
    return this.orchestrator.getLaunchers();
  }

  listSummary(): Record<string, LauncherSummary> {
    const summary: Record<string, LauncherSummary> = {};
    for (const launcher of this.orchestrator.getLaunchers()) {
      summary[launcher.name] = { ...summarizeLauncher(launcher), active: this.orchestrator.isLauncherActive(launcher.name) };
    }
    return summary;
  }

  async start(name: string, options: { noWait?: boolean } = {}): Promise<void> {
    await this.orchestrator.ensureActive(name, !options.noWait);
  }

  async restart(name: string, options: { noWait?: boolean } = {}): Promise<void> {
    this.orchestrator.stop(name);
    await this.orchestrator.ensureActive(name, !options.noWait);
  }

  stop(name: string): void {
    this.orchestrator.stop(name);
  }

  stopAll(): void {
    this.orchestrator.stopAll();
  }

  async status(name: string): Promise<LauncherStatus> {
    return this.orchestrator.getLauncherStatus(name);
  }

  isActive(name: string): boolean {
    return this.orchestrator.isLauncherActive(name);
  }

  pid(name: string): number | null {
    return this.orchestrator.getLauncherPid(name);
  }

  /** Path of the file receiving the launcher's stdout/stderr. */
  logFile(name: string): string | undefined {
    return this.orchestrator.getLauncherLogFile(name);
  }
}
