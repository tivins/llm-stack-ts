import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadStackConfig, resolveStackFile } from './config';
import { ConsoleLogger } from './Logger';
import { Orchestrator } from './Orchestrator';
import { ProcessManager } from './ProcessManager';
import type { LauncherStatus } from './LauncherStatus';
import type { LlmLauncher } from './LlmLauncher';
import type { Logger } from './Logger';

export interface StackOptions {
  /** Explicit path to stack.json. Falls back to $LLM_STACK_CONFIG, then ./stack.json. */
  file?: string;
  logger?: Logger;
  /** Directory used for PID files. Defaults to <tmpdir>/stack-llm. */
  pidDir?: string;
}

export interface LauncherSummary {
  readonly name: string;
  readonly type: string;
  readonly description: string;
  readonly active: boolean;
  readonly size: number;
}

/**
 * High-level entry point for controlling the LLM stack programmatically,
 * e.g. `new Stack().start('llm_main')`. Same orchestration logic as the
 * `stack` CLI (bin/cli.ts), just imported directly instead of shelled out to.
 */
export class Stack {
  private readonly orchestrator: Orchestrator;

  constructor(options: StackOptions = {}) {
    const file = resolveStackFile(options.file);
    const config = loadStackConfig(file);
    const logger = options.logger ?? new ConsoleLogger();
    const pidDir = options.pidDir ?? path.join(tmpdir(), 'stack-llm');

    this.orchestrator = new Orchestrator(new ProcessManager(pidDir, logger), config.vramCapacityGb, logger);
    for (const launcher of config.launchers) {
      this.orchestrator.addLauncher(launcher);
    }
  }

  list(): LlmLauncher[] {
    return this.orchestrator.getLaunchers();
  }

  listSummary(): Record<string, LauncherSummary> {
    const summary: Record<string, LauncherSummary> = {};
    for (const launcher of this.orchestrator.getLaunchers()) {
      summary[launcher.name] = {
        type: launcher.type,
        description: launcher.description,
        active: this.orchestrator.isLauncherActive(launcher.name),
        size: launcher.minimalVideoRamUsageInGigabytes,
        name: launcher.name,
      };
    }
    return summary;
  }

  async start(name: string, options: { noWait?: boolean } = {}): Promise<void> {
    await this.orchestrator.ensureActive(name, !options.noWait);
  }

  stop(name: string): void {
    this.orchestrator.stop(name);
  }

  async status(name: string): Promise<LauncherStatus> {
    return this.orchestrator.getLauncherStatus(name);
  }

  isActive(name: string): boolean {
    return this.orchestrator.isLauncherActive(name);
  }
}
