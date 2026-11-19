import { GpuLeaseLostError } from './errors';
import type { JobPriority, LeaseInfo, WaitReason } from './GpuLock';
import type { Orchestrator } from './Orchestrator';

/** Why a lease session ended. */
export type LeaseEndReason = 'stdin' | 'release' | 'signal' | 'broken';

/**
 * What `stack lease --json` writes, one JSON object per line. `waiting` repeats whenever the
 * holder, the position or the reason changes; `granted` comes once the lease is held and its
 * launcher (if any) is ready; each command gets `done` or `error`; `released` is the last line,
 * unless the session ends before the grant (`cancelled`, or `error` without `cmd`).
 */
export type LeaseEvent =
  | { event: 'waiting'; holder: LeaseInfo | null; position: number; reason: WaitReason }
  | { event: 'granted'; id: string; priority: JobPriority; launcher?: string }
  | { event: 'done'; cmd: string }
  | { event: 'error'; cmd?: string; message: string }
  | { event: 'cancelled'; why: 'stdin' | 'signal' }
  | { event: 'released'; why: LeaseEndReason };

export interface LeaseSessionOptions {
  holder: string;
  priority?: JobPriority;
  /** Started under the lease before `granted`, like `withLease({ launcher })`. */
  launcher?: string;
  maxWait?: number;
  /** Ends the session (Ctrl+C, SIGTERM, SIGHUP): leaves the queue, or releases the lease. */
  signal?: AbortSignal;
  /** How often the lease is checked for being broken by another client. Default 2 s. */
  pollMs?: number;
}

export const LEASE_COMMANDS = 'start <name>, restart <name>, stop <name>, touch, release';

/**
 * `stack lease`: holds a GPU lease for as long as `commands` (stdin, one command per line) stays
 * open, and runs the commands under it. Closing stdin releases the lease; closing it while still
 * waiting leaves the queue. Over ssh this makes a remote client's lease a process of the GPU
 * machine itself: if the client or the network dies, sshd closes stdin and the lease goes away.
 *
 * Errors before the grant (`GpuBusyError` after `maxWait`, an unknown launcher...) are thrown.
 * Errors of a command are reported as `error` events and the session goes on, except a broken
 * lease, which ends it.
 */
export async function runLeaseSession(
  orchestrator: Orchestrator,
  options: LeaseSessionOptions,
  commands: AsyncIterable<string>,
  emit: (event: LeaseEvent) => void,
): Promise<LeaseEndReason> {
  const pollMs = options.pollMs ?? 2000;
  const inputClosed = new AbortController();
  const stop = options.signal ? AbortSignal.any([options.signal, inputClosed.signal]) : inputClosed.signal;

  // stdin is read from the start, so that a client that goes away while waiting leaves the queue.
  const pending: string[] = [];
  let wake: (() => void) | undefined;
  const pump = (async () => {
    try {
      for await (const line of commands) {
        pending.push(line);
        wake?.();
      }
    } finally {
      inputClosed.abort();
      wake?.();
    }
  })();
  pump.catch(() => {});

  let lease;
  try {
    lease = await orchestrator.acquireLease({
      holder: options.holder,
      priority: options.priority,
      launcher: options.launcher,
      maxWait: options.maxWait,
      signal: stop,
      onWait: (holder, me) => emit({ event: 'waiting', holder, position: me.position, reason: me.reason }),
    });
  } catch (err) {
    if (!stop.aborted) throw err;
    const why = options.signal?.aborted ? 'signal' : 'stdin';
    emit({ event: 'cancelled', why });
    return why;
  }

  let why: LeaseEndReason | undefined;
  const watch = setInterval(() => {
    if (!lease.held) {
      why ??= 'broken';
      wake?.();
    }
  }, pollMs);
  const onAbort = () => wake?.();
  options.signal?.addEventListener('abort', onAbort);
  try {
    emit({ event: 'granted', id: lease.id, priority: lease.priority, launcher: options.launcher });
    while (why === undefined) {
      const line = pending.shift();
      if (line === undefined) {
        if (options.signal?.aborted) why = 'signal';
        else if (inputClosed.signal.aborted) why = 'stdin';
        else await new Promise<void>((resolve) => (wake = resolve));
        continue;
      }
      const cmd = line.trim();
      if (cmd === '') continue;
      const [verb, name, ...rest] = cmd.split(/\s+/);
      try {
        if (verb === 'release' && name === undefined) {
          why = 'release';
          break;
        }
        if (verb === 'touch' && name === undefined) {
          orchestrator.touchGpu();
        } else if ((verb === 'start' || verb === 'restart' || verb === 'stop') && name !== undefined && rest.length === 0) {
          if (verb === 'stop') await orchestrator.stop(name, { lease });
          else if (verb === 'restart') await orchestrator.restart(name, { lease, signal: options.signal });
          else await orchestrator.ensureActive(name, { lease, signal: options.signal });
        } else {
          throw new Error(`unknown command '${cmd}' (expected: ${LEASE_COMMANDS})`);
        }
        emit({ event: 'done', cmd });
      } catch (err) {
        if (err instanceof GpuLeaseLostError) why = 'broken';
        else if (options.signal?.aborted) why = 'signal';
        emit({ event: 'error', cmd, message: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    clearInterval(watch);
    options.signal?.removeEventListener('abort', onAbort);
    lease.release();
  }
  const end = why ?? 'release';
  emit({ event: 'released', why: end });
  return end;
}
