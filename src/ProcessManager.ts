import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Launcher } from './Launcher';
import type { Logger } from './Logger';

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface StartedProcess {
  readonly pid: number;
  /** Resolves when the spawned process exits (only observable from the process that started it). */
  readonly exited: Promise<ProcessExit>;
}

export interface ProcessController {
  isActive(launcher: Launcher): boolean;
  getPid(launcher: Launcher): number | null;
  start(launcher: Launcher): StartedProcess;
  stop(launcher: Launcher): void;
  /** Path of the file receiving the launcher's stdout/stderr, if any. */
  logFile?(launcher: Launcher): string;
}

interface ProcStat {
  readonly state: string;
  readonly pgrp: number;
  readonly startTime: string;
}

interface TrackedPid {
  readonly pid: number;
  /** Kernel start time (/proc/<pid>/stat field 22); absent in PID files written before 0.4.0. */
  readonly startTime?: string;
}

/**
 * Tracks and controls launcher processes via PID files (Linux only).
 *
 * A process started here is identified by its PID and kernel start time, so it
 * stays tracked whatever it exec()s into. `process_match` is only used to adopt
 * a process that `stack` did not start (or whose PID file was lost).
 */
export class ProcessManager implements ProcessController {
  private readonly pidDir: string;
  private readonly logDir?: string;

  constructor(pidDir: string, private readonly logger?: Logger, logDir?: string) {
    this.pidDir = pidDir.replace(/\/+$/, '');
    mkdirSync(this.pidDir, { recursive: true });
    if (logDir !== undefined) {
      this.logDir = logDir.replace(/\/+$/, '');
      mkdirSync(this.logDir, { recursive: true });
    }
  }

  isActive(launcher: Launcher): boolean {
    return this.resolvePid(launcher) !== null;
  }

  getPid(launcher: Launcher): number | null {
    return this.resolvePid(launcher);
  }

  logFile(launcher: Launcher): string {
    return path.join(this.logDir ?? this.pidDir, `${launcher.name}.log`);
  }

  /** Starts the launcher's command in its own process group, with output appended to its log file. */
  start(launcher: Launcher): StartedProcess {
    if (launcher.cwd !== undefined && !existsSync(launcher.cwd)) {
      throw new Error(`Cannot start ${launcher.name}: cwd not found: ${launcher.cwd}`);
    }

    const logFile = this.logFile(launcher);
    this.rotateLog(logFile);
    const logFd = openSync(logFile, 'a');

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      // `exec` replaces the bash process so the PID we capture is the real
      // service process, not a wrapper shell.
      proc = Bun.spawn(['bash', '-c', `exec ${launcher.commandLine}`], {
        cwd: launcher.cwd,
        env: { ...process.env, ...launcher.env },
        stdin: 'ignore',
        stdout: logFd,
        stderr: logFd,
        detached: true,
      });
    } finally {
      closeSync(logFd);
    }
    proc.unref();

    if (proc.pid <= 0) {
      throw new Error(`Failed to start ${launcher.name}`);
    }

    this.writePidFile(launcher.name, { pid: proc.pid, startTime: this.readStat(proc.pid)?.startTime });

    const exited = proc.exited.then(() => ({ code: proc.exitCode, signal: proc.signalCode }));
    return { pid: proc.pid, exited };
  }

  stop(launcher: Launcher): void {
    const pid = this.resolvePid(launcher);
    if (pid !== null) {
      // Processes we start lead their own group: signal the whole group so
      // children of a wrapper script do not survive holding VRAM. An adopted
      // process may share its group with unrelated processes (e.g. a shell).
      const group = this.readStat(pid)?.pgrp === pid;
      const isAlive = group ? () => this.isGroupAlive(pid) : () => this.isRunning(pid);

      this.signal(pid, group, 'SIGTERM');
      if (!this.waitUntil(() => !isAlive(), launcher.stopTimeoutSeconds * 1000)) {
        this.logger?.log(`${launcher.name} did not exit after ${launcher.stopTimeoutSeconds}s, sending SIGKILL`);
        this.signal(pid, group, 'SIGKILL');
        this.waitUntil(() => !isAlive(), 2000);
      }
    }
    this.removePidFile(launcher.name);
  }

  private resolvePid(launcher: Launcher): number | null {
    const tracked = this.readPidFile(launcher.name);

    if (tracked !== null) {
      if (this.isTrackedAlive(tracked, launcher)) {
        return tracked.pid;
      }
      this.removePidFile(launcher.name);
    }

    const discovered = this.findMatchingPid(launcher, this.claimedPids(launcher.name));
    if (discovered === null) {
      return null;
    }

    this.writePidFile(launcher.name, { pid: discovered, startTime: this.readStat(discovered)?.startTime });
    this.logger?.log(`Re-synced PID for ${launcher.name} (${discovered})`);

    return discovered;
  }

  private isTrackedAlive(tracked: TrackedPid, launcher: Launcher): boolean {
    const stat = this.readStat(tracked.pid);
    if (stat === null || stat.state === 'Z') {
      return false;
    }

    if (tracked.startTime !== undefined) {
      return stat.startTime === tracked.startTime;
    }

    // Legacy PID file: fall back to the command line check, then upgrade it.
    const cmdline = this.readCmdline(tracked.pid);
    if (cmdline === null || !this.matches(cmdline, launcher)) {
      return false;
    }
    this.writePidFile(launcher.name, { pid: tracked.pid, startTime: stat.startTime });
    return true;
  }

  /**
   * `process_match` is a substring; without it the whole command line must match,
   * so a short command (e.g. `python`) never adopts an unrelated process.
   */
  private matches(cmdline: string, launcher: Launcher): boolean {
    if (launcher.processMatch !== undefined) {
      return cmdline.includes(launcher.processMatch);
    }
    const normalize = (value: string) => value.trim().replace(/\s+/g, ' ');
    return normalize(cmdline) === normalize(launcher.commandLine);
  }

  /** PIDs owned by other launchers' PID files, so two launchers sharing a pattern never adopt the same process. */
  private claimedPids(exceptName: string): Set<number> {
    const claimed = new Set<number>();
    let entries: string[];
    try {
      entries = readdirSync(this.pidDir);
    } catch {
      return claimed;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.pid') || entry === `${exceptName}.pid`) {
        continue;
      }
      const tracked = this.readPidFile(entry.slice(0, -'.pid'.length));
      if (tracked !== null) {
        claimed.add(tracked.pid);
      }
    }
    return claimed;
  }

  private pidFilePath(name: string): string {
    return path.join(this.pidDir, `${name}.pid`);
  }

  private readPidFile(name: string): TrackedPid | null {
    let content: string;
    try {
      content = readFileSync(this.pidFilePath(name), 'utf-8');
    } catch {
      return null;
    }

    const [pidPart, startTime] = content.trim().split(/\s+/);
    const pid = Number.parseInt(pidPart ?? '', 10);
    return pid > 0 ? { pid, startTime } : null;
  }

  private removePidFile(name: string): void {
    const filePath = this.pidFilePath(name);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }

  private writePidFile(name: string, tracked: TrackedPid): void {
    const content = tracked.startTime === undefined ? `${tracked.pid}` : `${tracked.pid} ${tracked.startTime}`;
    writeFileSync(this.pidFilePath(name), content);
  }

  /** Keeps the previous run's log as `<name>.log.1`. */
  private rotateLog(logFile: string): void {
    if (existsSync(logFile)) {
      renameSync(logFile, `${logFile}.1`);
    }
  }

  private findMatchingPid(launcher: Launcher, excluded: Set<number>): number | null {
    const candidates: number[] = [];
    for (const pid of this.listPids()) {
      if (pid === process.pid || pid === process.ppid || excluded.has(pid)) {
        continue;
      }
      const cmdline = this.readCmdline(pid);
      if (cmdline !== null && this.matches(cmdline, launcher) && this.readStat(pid)?.state !== 'Z') {
        candidates.push(pid);
      }
    }

    // Prefer a group leader: it is what `start` would have recorded.
    return candidates.find((pid) => this.readStat(pid)?.pgrp === pid) ?? candidates[0] ?? null;
  }

  private listPids(): number[] {
    try {
      return readdirSync('/proc')
        .filter((entry) => /^\d+$/.test(entry))
        .map((entry) => Number.parseInt(entry, 10));
    } catch {
      return [];
    }
  }

  private readStat(pid: number): ProcStat | null {
    let content: string;
    try {
      content = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    } catch {
      return null;
    }

    // "pid (comm) state ppid pgrp ..." — comm may contain spaces and parentheses.
    const fields = content.slice(content.lastIndexOf(')') + 2).split(' ');
    const state = fields[0];
    const pgrp = Number.parseInt(fields[2] ?? '', 10);
    const startTime = fields[19];
    if (state === undefined || Number.isNaN(pgrp) || startTime === undefined) {
      return null;
    }
    return { state, pgrp, startTime };
  }

  private readCmdline(pid: number): string | null {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ');
    } catch {
      return null;
    }
  }

  private isRunning(pid: number): boolean {
    const stat = this.readStat(pid);
    return stat !== null && stat.state !== 'Z';
  }

  private isGroupAlive(pgid: number): boolean {
    return this.listPids().some((pid) => {
      const stat = this.readStat(pid);
      return stat !== null && stat.pgrp === pgid && stat.state !== 'Z';
    });
  }

  private signal(pid: number, group: boolean, signal: NodeJS.Signals): void {
    try {
      process.kill(group ? -pid : pid, signal);
    } catch {
      // Already gone.
    }
  }

  private waitUntil(condition: () => boolean, timeoutMs: number): boolean {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (condition()) {
        return true;
      }
      Bun.sleepSync(100);
    }
    return condition();
  }
}
