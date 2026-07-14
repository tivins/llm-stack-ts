import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { LlmLauncher } from './LlmLauncher';
import type { Logger } from './Logger';

export interface ProcessController {
  isActive(launcher: LlmLauncher): boolean;
  start(launcher: LlmLauncher): number;
  stop(launcher: LlmLauncher): void;
}

/** Tracks and controls launcher processes via PID files, re-synced against /proc when needed (Linux only). */
export class ProcessManager implements ProcessController {
  private readonly pidDir: string;

  constructor(pidDir: string, private readonly logger?: Logger) {
    this.pidDir = pidDir.replace(/\/+$/, '');
    mkdirSync(this.pidDir, { recursive: true });
  }

  isActive(launcher: LlmLauncher): boolean {
    return this.resolvePid(launcher) !== null;
  }

  /** Starts the launcher's command in a detached process and returns its PID (or the existing PID if already active). */
  start(launcher: LlmLauncher): number {
    const existingPid = this.resolvePid(launcher);
    if (existingPid !== null) {
      return existingPid;
    }

    // `exec` replaces the bash process so the PID we capture is the real
    // service process, not a wrapper shell.
    const proc = Bun.spawn(['bash', '-c', `exec ${launcher.commandLine}`], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      detached: true,
    });
    proc.unref();

    if (proc.pid <= 0) {
      throw new Error(`Failed to start ${launcher.name}`);
    }

    this.writePidFile(launcher.name, proc.pid);
    return proc.pid;
  }

  stop(launcher: LlmLauncher): void {
    const pid = this.resolvePid(launcher);
    if (pid !== null) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
      this.waitForExit(pid);
    }
    this.removePidFile(launcher.name);
  }

  private resolvePid(launcher: LlmLauncher): number | null {
    const pattern = this.matchPattern(launcher);
    const pid = this.readPidFile(launcher.name);

    if (pid !== null && this.isPidAlive(pid, pattern)) {
      return pid;
    }

    if (pid !== null) {
      this.removePidFile(launcher.name);
    }

    const discovered = this.findMatchingPid(pattern);
    if (discovered === null) {
      return null;
    }

    this.writePidFile(launcher.name, discovered);
    this.logger?.log(`Re-synced PID for ${launcher.name} (${discovered})`);

    return discovered;
  }

  private matchPattern(launcher: LlmLauncher): string {
    return launcher.processMatch ?? launcher.commandLine;
  }

  private pidFilePath(name: string): string {
    return path.join(this.pidDir, `${name}.pid`);
  }

  private readPidFile(name: string): number | null {
    const filePath = this.pidFilePath(name);
    if (!existsSync(filePath)) {
      return null;
    }

    const pid = Number.parseInt(readFileSync(filePath, 'utf-8').trim(), 10);
    return pid > 0 ? pid : null;
  }

  private removePidFile(name: string): void {
    const filePath = this.pidFilePath(name);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }

  private writePidFile(name: string, pid: number): void {
    writeFileSync(this.pidFilePath(name), String(pid));
  }

  private findMatchingPid(expectedPattern: string): number | null {
    let pidDirs: string[];
    try {
      pidDirs = readdirSync('/proc').filter((entry) => /^\d+$/.test(entry));
    } catch {
      return null;
    }

    for (const pidDir of pidDirs) {
      const pid = Number.parseInt(pidDir, 10);
      const cmdline = this.readCmdline(pid);
      if (cmdline !== null && cmdline.includes(expectedPattern)) {
        return pid;
      }
    }

    return null;
  }

  private isPidAlive(pid: number, expectedPattern: string): boolean {
    if (pid <= 0 || !existsSync(`/proc/${pid}`)) {
      return false;
    }

    const cmdline = this.readCmdline(pid);
    return cmdline !== null && cmdline.includes(expectedPattern);
  }

  private readCmdline(pid: number): string | null {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ');
    } catch {
      return null;
    }
  }

  private waitForExit(pid: number, timeoutMs = 5000): void {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!existsSync(`/proc/${pid}`)) {
        return;
      }
      Bun.sleepSync(100);
    }

    if (existsSync(`/proc/${pid}`)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
}
