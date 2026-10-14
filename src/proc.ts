import { readFileSync } from 'node:fs';

export interface ProcStat {
  readonly state: string;
  readonly pgrp: number;
  /** Kernel start time (/proc/<pid>/stat field 22): with the PID, identifies a process even after PID reuse. */
  readonly startTime: string;
}

export function readProcStat(pid: number): ProcStat | null {
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

/** True while the process identified by `pid` and `startTime` runs (a zombie or a reused PID does not count). */
export function isProcessAlive(pid: number, startTime: string | undefined): boolean {
  const stat = readProcStat(pid);
  return stat !== null && stat.state !== 'Z' && (startTime === undefined || stat.startTime === startTime);
}
