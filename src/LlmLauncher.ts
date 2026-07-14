import type { LauncherHealth } from './LauncherHealth';
import type { LlmType } from './LlmType';

export interface LlmLauncher {
  readonly name: string;
  readonly type: LlmType;
  readonly description: string;
  readonly commandLine: string;
  readonly minimalVideoRamUsageInGigabytes: number;
  readonly allowFullCPU: boolean;
  /** Substring matched against `/proc/<pid>/cmdline` to re-detect the process (defaults to commandLine). */
  readonly processMatch?: string;
  readonly health?: LauncherHealth;
}
