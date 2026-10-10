import type { Args } from './args';
import type { LauncherKind } from './config';
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
  /** Parent launcher named by `extends` (may be an abstract one, absent from the launcher list). */
  readonly extends?: string;
  readonly kind?: LauncherKind;
  /** `port` key, or the llama-server default. */
  readonly port?: number;
  /** Resolved args: inherited ones merged with the launcher's own, variables substituted. */
  readonly args?: Readonly<Args>;
  /** The subset of `args` declared by the launcher itself, i.e. what a variant changes. */
  readonly ownArgs?: Readonly<Args>;
}

/** @deprecated Use `Launcher`. */
export type LlmLauncher = Launcher;
