import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GpuBusyError, GpuLeaseLostError } from './errors';
import { isProcessAlive, readProcStat } from './proc';
import { sleep } from './sleep';

const DEFAULT_POLL_MS = 200;
const DEFAULT_PRIORITY: JobPriority = 1;
/** Quiet time a P2 job waits for, after the last P0/P1 activity. */
export const DEFAULT_IDLE_MS = 60_000;
/** A job waiting this long for another launcher ends the current batch. */
export const DEFAULT_SWITCH_AFTER_MS = 120_000;
/** Jobs run in a row for the same launcher before the others get their turn. */
export const DEFAULT_MAX_BATCH = 8;

/** 0: interactive (chat), 1: asked by the user (image), 2: background. Lower goes first. */
export type JobPriority = 0 | 1 | 2;

/**
 * Why a client is still waiting: the GPU is held or another client goes first (`turn`), a
 * higher priority goes first (`priority`), a later job for the loaded launcher goes first
 * (`batch`), or a background job waits for the GPU to be quiet (`idle`).
 */
export type WaitReason = 'turn' | 'priority' | 'batch' | 'idle';

export interface LeaseInfo {
  readonly id: string;
  /** Free text given by the client, e.g. `flow_editor: run 42`. */
  readonly holder: string;
  readonly pid: number;
  readonly priority: JobPriority;
  /** Launcher the job needs, used to run the jobs of the same model in a row. */
  readonly launcher?: string;
  readonly requestedAt: Date;
  /** Set once the lease is granted. */
  readonly acquiredAt?: Date;
  /** Set on waiting clients, in `GpuStatus.waiting`. */
  readonly reason?: WaitReason;
}

export interface GpuStatus {
  /** The client holding the GPU, null when it is free. */
  readonly holder: LeaseInfo | null;
  /** Clients waiting for their turn, in the order they will get it (as things stand). */
  readonly waiting: LeaseInfo[];
}

export interface QueuePosition {
  /** 0 = next to get the GPU. */
  readonly position: number;
  readonly reason: WaitReason;
}

export interface AcquireOptions {
  /** Free text shown to the other clients while they wait, and by `stack gpu`. */
  holder: string;
  /** Default 1. */
  priority?: JobPriority;
  /** Launcher the job needs: jobs for the launcher already loaded are run in a row. */
  launcher?: string;
  /** Quiet time to wait for after the last P0/P1 activity (default: the lock's `idleMs` for P2, none otherwise). */
  idleMs?: number;
  /** Gives up after this long, with `GpuBusyError`. 0 = only if the GPU can be had at once. */
  maxWait?: number;
  /** Leaves the queue: `acquire` then rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Called while waiting, each time the holder, the position or the reason changes. */
  onWait?: (holder: LeaseInfo | null, me: QueuePosition) => void;
}

export interface GpuLockOptions {
  pollMs?: number;
  /** Default quiet time of P2 jobs. */
  idleMs?: number;
  /** A job waiting this long for another launcher ends the current batch. */
  switchAfterMs?: number;
  /** Jobs run in a row for the same launcher before the others get their turn. */
  maxBatch?: number;
}

interface TicketRecord {
  holder: string;
  pid: number;
  startTime?: string;
  requestedAt: number;
  acquiredAt?: number;
  priority?: JobPriority;
  launcher?: string;
  idleMs?: number;
}

/** Written by each new holder: what the GPU was last given to, for the batches. */
interface QueueState {
  launcher?: string;
  streak: number;
}

interface Ticket {
  readonly file: string;
  readonly number: number;
  readonly id: string;
}

interface LiveTicket extends LeaseInfo {
  readonly idleMs: number;
}

const TICKET = /^ticket-(\d+)-(\d+\.[0-9a-f]+)$/;
const CHOOSING = /^choosing-(\d+\.[0-9a-f]+)$/;
const STATE_FILE = 'state.json';
const ACTIVITY_FILE = 'activity.json';

/** The lease being used by the current async context (set by `GpuLock.withLease`). */
const leaseContext = new AsyncLocalStorage<GpuLease>();

/** The right to change GPU services, granted by `GpuLock.acquire`, until `release`. */
export class GpuLease {
  private released = false;

  constructor(
    /** Lock directory the lease belongs to. */
    readonly dir: string,
    readonly id: string,
    readonly holder: string,
    private readonly ticketFile: string,
    readonly priority: JobPriority = DEFAULT_PRIORITY,
  ) {}

  /** False once released, or once another client broke the lease (`stack gpu release --force`). */
  get held(): boolean {
    return !this.released && existsSync(this.ticketFile);
  }

  release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    removeFile(this.ticketFile);
    if (this.priority < 2) {
      writeActivity(this.dir);
    }
  }
}

/**
 * GPU lease shared by every process using the same directory: one holder at a time, the others
 * wait in a queue ordered by priority, then by launcher (to load a model once for several jobs),
 * then by arrival. No daemon: each client drops a ticket file and computes the same order from
 * the directory. The client first in that order claims the GPU by marking its ticket, then checks
 * that nobody else did; if someone did, it backs off. A client that dies loses its turn (its PID
 * and start time no longer match a running process), so a crash never leaves the GPU locked.
 */
export class GpuLock {
  readonly dir: string;
  private readonly pollMs: number;
  private readonly idleMs: number;
  private readonly switchAfterMs: number;
  private readonly maxBatch: number;

  constructor(dir: string, options: GpuLockOptions = {}) {
    this.dir = dir.replace(/\/+$/, '');
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.switchAfterMs = options.switchAfterMs ?? DEFAULT_SWITCH_AFTER_MS;
    this.maxBatch = options.maxBatch ?? DEFAULT_MAX_BATCH;
    mkdirSync(this.dir, { recursive: true });
  }

  /** Waits for the GPU. The caller must `release()` the lease; prefer `withLease`, which does it. */
  async acquire(options: AcquireOptions): Promise<GpuLease> {
    options.signal?.throwIfAborted();
    const priority = options.priority ?? DEFAULT_PRIORITY;
    if (![0, 1, 2].includes(priority)) {
      throw new RangeError(`GPU job priority must be 0, 1 or 2, got ${priority}`);
    }
    const id = `${process.pid}.${randomBytes(4).toString('hex')}`;
    const startTime = readProcStat(process.pid)?.startTime;
    const record: TicketRecord = {
      holder: options.holder,
      pid: process.pid,
      startTime,
      requestedAt: Date.now(),
      priority,
      launcher: options.launcher,
      idleMs: options.idleMs ?? (priority === 2 ? this.idleMs : 0),
    };

    // Bakery: while choosing, others wait; the number is one above every ticket seen.
    const choosing = path.join(this.dir, `choosing-${id}`);
    this.writeAtomic(choosing, { pid: process.pid, startTime });
    let ticketFile: string;
    try {
      const number = Math.max(0, ...this.listTickets().map((ticket) => ticket.number)) + 1;
      ticketFile = path.join(this.dir, `ticket-${number}-${id}`);
      this.writeAtomic(ticketFile, record);
    } finally {
      removeFile(choosing);
    }

    try {
      await this.waitForTurn(id, ticketFile, record, options);
    } catch (err) {
      removeFile(ticketFile);
      throw err;
    }
    return new GpuLease(this.dir, id, options.holder, ticketFile, priority);
  }

  /**
   * Runs `fn` holding the GPU, then releases it, even on error. Inside `fn`, `currentLease()`
   * returns the lease, and a nested `withLease` reuses it instead of waiting for itself.
   */
  async withLease<T>(options: AcquireOptions, fn: (lease: GpuLease) => Promise<T>): Promise<T> {
    const current = this.currentLease();
    if (current) {
      return fn(current);
    }

    const lease = await this.acquire(options);
    try {
      return await leaseContext.run(lease, () => fn(lease));
    } finally {
      lease.release();
    }
  }

  /** The lease of the enclosing `withLease`, if it belongs to this lock and is not released. */
  currentLease(): GpuLease | undefined {
    const lease = leaseContext.getStore();
    return lease !== undefined && lease.dir === this.dir && lease.held ? lease : undefined;
  }

  status(): GpuStatus {
    const tickets = this.liveTickets();
    const holder = tickets.find((ticket) => ticket.acquiredAt !== undefined) ?? null;
    const waiting = this.order(tickets.filter((ticket) => ticket !== holder));
    return { holder: holder === null ? null : toInfo(holder), waiting: waiting.map(toInfo) };
  }

  /** Marks the GPU as in use: P2 jobs wait for `idleMs` from now (e.g. the user is typing). */
  touch(): void {
    writeActivity(this.dir);
  }

  /** Removes a waiting client from the queue: its `acquire` rejects with `GpuLeaseLostError`. Null if not waiting. */
  cancel(id: string): LeaseInfo | null {
    const waiting = this.status().waiting.find((ticket) => ticket.id === id);
    if (waiting === undefined) {
      return null;
    }
    for (const ticket of this.listTickets()) {
      if (ticket.id === id) removeFile(ticket.file);
    }
    return waiting;
  }

  /** Breaks the current lease. Its holder is not told: it keeps running as if it still held the GPU. */
  forceRelease(): LeaseInfo | null {
    const holder = this.status().holder;
    if (holder !== null) {
      for (const ticket of this.listTickets()) {
        if (ticket.id === holder.id) removeFile(ticket.file);
      }
    }
    return holder;
  }

  private async waitForTurn(id: string, ticketFile: string, record: TicketRecord, options: AcquireOptions): Promise<void> {
    const since = Date.now();
    let lastSeen: string | undefined;
    for (;;) {
      options.signal?.throwIfAborted();
      if (!this.othersChoosing(id)) {
        const tickets = this.liveTickets();
        if (!tickets.some((ticket) => ticket.id === id)) {
          throw new GpuLeaseLostError(`GPU lease of ${options.holder} was broken while waiting`);
        }
        const holder = tickets.find((ticket) => ticket.acquiredAt !== undefined) ?? null;
        const waiting = this.order(tickets.filter((ticket) => ticket !== holder));
        const position = waiting.findIndex((ticket) => ticket.id === id);
        const me = waiting[position];

        if (holder === null && me?.reason === undefined && (await this.claim(id, ticketFile, record, options.signal))) {
          return;
        }

        if (me !== undefined) {
          const seen = `${holder?.id}|${position}|${me.reason ?? 'turn'}`;
          if (seen !== lastSeen) {
            lastSeen = seen;
            options.onWait?.(holder === null ? null : toInfo(holder), { position, reason: me.reason ?? 'turn' });
          }
        }
        if (options.maxWait !== undefined && Date.now() - since >= options.maxWait) {
          const status = { holder: holder === null ? null : toInfo(holder), waiting: waiting.filter((t) => t.id !== id).map(toInfo) };
          throw new GpuBusyError(options.holder, status);
        }
      }
      await sleep(this.pollMs, options.signal);
    }
  }

  /**
   * Marks the ticket as holding the GPU, then checks that no other client did the same meanwhile.
   * Of two clients that claim at once, the second to write always sees the first and backs off;
   * both may back off, never both stay. Also records the grant for the batches and the idle wait.
   */
  private async claim(id: string, ticketFile: string, record: TicketRecord, signal?: AbortSignal): Promise<boolean> {
    this.writeAtomic(ticketFile, { ...record, acquiredAt: Date.now() });
    const rival = this.liveTickets().some((ticket) => ticket.id !== id && ticket.acquiredAt !== undefined);
    if (rival) {
      this.writeAtomic(ticketFile, record);
      await sleep(Math.random() * this.pollMs, signal);
      return false;
    }

    if (record.launcher !== undefined) {
      const state = this.readState();
      const streak = state.launcher === record.launcher ? state.streak + 1 : 1;
      this.writeAtomic(path.join(this.dir, STATE_FILE), { launcher: record.launcher, streak } satisfies QueueState);
    }
    if ((record.priority ?? DEFAULT_PRIORITY) < 2) {
      writeActivity(this.dir);
    }
    return true;
  }

  /**
   * Waiting tickets in the order they get the GPU, each with the reason it is not first; the
   * first one has no reason when it may take the GPU now. Priority first; within a priority, the
   * jobs for the launcher of the last grant go first while the batch lasts (fewer than `maxBatch`
   * jobs in a row, and no other job of that priority waiting for `switchAfterMs`); then arrival.
   * P2 jobs wait for `idleMs` without P0/P1 activity.
   */
  private order(waiting: LiveTicket[], now = Date.now()): LiveTicket[] {
    const state = this.readState();
    const lastActivity = this.readActivity();

    const batchOpen = (priority: JobPriority) =>
      state.launcher !== undefined &&
      state.streak < this.maxBatch &&
      !waiting.some(
        (t) => t.priority === priority && t.launcher !== state.launcher && now - t.requestedAt.getTime() >= this.switchAfterMs,
      );
    const open = new Map<JobPriority, boolean>(([0, 1, 2] as const).map((p) => [p, batchOpen(p)]));
    const batched = (t: LiveTicket) => open.get(t.priority) === true && t.launcher === state.launcher;

    // `waiting` comes in arrival order and the sort is stable.
    const sorted = [...waiting].sort((a, b) => a.priority - b.priority || Number(batched(b)) - Number(batched(a)));

    let first: LiveTicket | undefined;
    return sorted.map((ticket, index) => {
      let reason: WaitReason | undefined;
      if (ticket.idleMs > 0 && lastActivity !== undefined && now - lastActivity < ticket.idleMs) {
        reason = 'idle';
      } else if (first !== undefined) {
        reason = first.priority < ticket.priority ? 'priority' : first.requestedAt > ticket.requestedAt ? 'batch' : 'turn';
      } else if (sorted.slice(0, index).some((t) => t.priority < ticket.priority)) {
        // Never pass a higher priority job, even one that waits for the GPU to be quiet.
        reason = 'priority';
      } else {
        first = ticket;
      }
      return { ...ticket, reason };
    });
  }

  /** True while another live client is picking its ticket number. */
  private othersChoosing(id: string): boolean {
    for (const entry of this.readDir()) {
      const match = CHOOSING.exec(entry);
      if (match?.[1] === undefined || match[1] === id) {
        continue;
      }
      const file = path.join(this.dir, entry);
      const owner = readRecord<{ pid: number; startTime?: string }>(file);
      if (owner === null) {
        continue;
      }
      if (isProcessAlive(owner.pid, owner.startTime)) {
        return true;
      }
      removeFile(file);
    }
    return false;
  }

  /** Tickets of live clients, in arrival order. Tickets of dead clients are removed on the way. */
  private liveTickets(): LiveTicket[] {
    const live: LiveTicket[] = [];
    for (const ticket of this.listTickets()) {
      const record = readRecord<TicketRecord>(ticket.file);
      if (record === null) {
        continue;
      }
      if (!isProcessAlive(record.pid, record.startTime)) {
        removeFile(ticket.file);
        continue;
      }
      live.push({
        id: ticket.id,
        holder: record.holder,
        pid: record.pid,
        priority: record.priority ?? DEFAULT_PRIORITY,
        launcher: record.launcher,
        idleMs: record.idleMs ?? 0,
        requestedAt: new Date(record.requestedAt),
        acquiredAt: record.acquiredAt === undefined ? undefined : new Date(record.acquiredAt),
      });
    }
    return live;
  }

  /** Every ticket file, sorted by number then id (the bakery order). */
  private listTickets(): Ticket[] {
    const tickets: Ticket[] = [];
    for (const entry of this.readDir()) {
      const match = TICKET.exec(entry);
      if (match?.[1] !== undefined && match[2] !== undefined) {
        tickets.push({ file: path.join(this.dir, entry), number: Number(match[1]), id: match[2] });
      }
    }
    return tickets.sort((a, b) => a.number - b.number || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  private readState(): QueueState {
    return readRecord<QueueState>(path.join(this.dir, STATE_FILE)) ?? { streak: 0 };
  }

  /** Time of the last P0/P1 grant or release, or `touch()`; undefined if none yet. */
  private readActivity(): number | undefined {
    return readRecord<{ at: number }>(path.join(this.dir, ACTIVITY_FILE))?.at;
  }

  private readDir(): string[] {
    try {
      return readdirSync(this.dir);
    } catch {
      return [];
    }
  }

  private writeAtomic(file: string, content: object): void {
    writeAtomic(this.dir, file, content);
  }
}

function toInfo(ticket: LiveTicket): LeaseInfo {
  const { idleMs: _idleMs, ...info } = ticket;
  return info;
}

/** Null when the file is gone (released meanwhile) or unreadable. */
function readRecord<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

/** Readers never see a half-written file: write aside, then rename. */
function writeAtomic(dir: string, file: string, content: object): void {
  const tmp = path.join(dir, `.tmp-${path.basename(file)}-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(content));
  renameSync(tmp, file);
}

function writeActivity(dir: string): void {
  try {
    writeAtomic(dir, path.join(dir, ACTIVITY_FILE), { at: Date.now() });
  } catch {
    // The lock directory was removed: nobody is left to wait.
  }
}

function removeFile(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Already gone.
  }
}

/** `3m12s`, `45s`, `1h05m`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  }
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

/** `flow_editor: run 42 (pid 1234) for 3m12s`. */
export function describeLease(lease: LeaseInfo, now = Date.now()): string {
  const since = lease.acquiredAt ?? lease.requestedAt;
  return `${lease.holder} (pid ${lease.pid}) for ${formatDuration(now - since.getTime())}`;
}
