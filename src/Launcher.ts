import type { LauncherHealth } from './LauncherHealth';

export interface Launcher {
  readonly name: string;
  readonly description: string;
  /** Free-form label (e.g. "text-generation", "image"); empty when not set. */
  readonly type: string;
  readonly commandLine: string;
  /** Working directory for the command (defaults to the caller's cwd). */
  readonly cwd?: string;
  /** Extra environment variables, merged over the caller's environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** VRAM budget, only counted when `gpu` is true. */
  readonly vramGb: number;
  /** Counts `vramGb` against the stack's VRAM capacity. */
  readonly gpu: boolean;
  /** Starting this launcher stops every other running exclusive launcher. */
  readonly exclusive: boolean;
  /** Substring of `/proc/<pid>/cmdline` used to adopt a process started outside `stack` (default: exact commandLine match). */
  readonly processMatch?: string;
  /** Delay between SIGTERM and SIGKILL when stopping. */
  readonly stopTimeoutSeconds: number;
  readonly health?: LauncherHealth;
}

/** @deprecated Use `Launcher`. */
export type LlmLauncher = Launcher;
