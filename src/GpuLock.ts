import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GpuLeaseLostError } from './errors';
import { isProcessAlive, readProcStat } from './proc';
import { sleep } from './sleep';

const DEFAULT_POLL_MS = 200;

export interface LeaseInfo {
  readonly id: string;
  /** Free text given by the client, e.g. `flow_editor: run 42`. */
  readonly holder: string;
  readonly pid: number;
  readonly requestedAt: Date;
  /** Set once the lease is granted. */
  readonly acquiredAt?: Date;
}

export interface GpuStatus {
  /** The client holding the GPU, null when it is free. */
  readonly holder: LeaseInfo | null;
  /** Clients waiting for their turn, in order. */
  readonly waiting: LeaseInfo[];
}

export interface AcquireOptions {
  /** Free text shown to the other clients while they wait, and by `stack gpu`. */
  holder: string;
  /** Leaves the queue: `acquire` then rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Called while waiting, each time another client becomes the holder. */
  onWait?: (holder: LeaseInfo) => void;
}

interface TicketRecord {
  holder: string;
  pid: number;
  startTime?: string;
  requestedAt: number;
  acquiredAt?: number;
}

interface Ticket {
  readonly file: string;
  readonly number: number;
  readonly id: string;
}

const TICKET = /^ticket-(\d+)-(\d+\.[0-9a-f]+)$/;
const CHOOSING = /^choosing-(\d+\.[0-9a-f]+)$/;

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
  }
}

/**
 * GPU lease shared by every process using the same directory: one holder at a time, the others
 * wait in order of arrival. No daemon: each client drops a ticket file, numbered with Lamport's
 * bakery algorithm, and the lowest live ticket holds the GPU. A client that dies loses its turn
 * (its PID and start time no longer match a running process), so a crash never leaves the GPU locked.
 */
export class GpuLock {
  readonly dir: string;
  private readonly pollMs: number;

  constructor(dir: string, options: { pollMs?: number } = {}) {
    this.dir = dir.replace(/\/+$/, '');
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    mkdirSync(this.dir, { recursive: true });
  }

  /** Waits for the GPU. The caller must `release()` the lease; prefer `withLease`, which does it. */
  async acquire(options: AcquireOptions): Promise<GpuLease> {
    options.signal?.throwIfAborted();
    const id = `${process.pid}.${randomBytes(4).toString('hex')}`;
    const startTime = readProcStat(process.pid)?.startTime;
    const record: TicketRecord = { holder: options.holder, pid: process.pid, startTime, requestedAt: Date.now() };

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
      await this.waitForTurn(id, options);
    } catch (err) {
      removeFile(ticketFile);
      throw err;
    }
    this.writeAtomic(ticketFile, { ...record, acquiredAt: Date.now() });
    return new GpuLease(this.dir, id, options.holder, ticketFile);
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
    const queue = this.liveTickets();
    const first = queue[0];
    if (first?.acquiredAt === undefined) {
      return { holder: null, waiting: queue };
    }
    return { holder: first, waiting: queue.slice(1) };
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

  private async waitForTurn(id: string, options: AcquireOptions): Promise<void> {
    let lastHolder: string | undefined;
    for (;;) {
      options.signal?.throwIfAborted();
      if (!this.othersChoosing(id)) {
        const queue = this.liveTickets();
        const position = queue.findIndex((ticket) => ticket.id === id);
        if (position === -1) {
          throw new GpuLeaseLostError(`GPU lease of ${options.holder} was broken while waiting`);
        }
        if (position === 0) {
          return;
        }
        const first = queue[0];
        if (first !== undefined && first.id !== lastHolder) {
          lastHolder = first.id;
          options.onWait?.(first);
        }
      }
      await sleep(this.pollMs, options.signal);
    }
  }

  /** True while another live client is picking its ticket number. */
  private othersChoosing(id: string): boolean {
    for (const entry of this.readDir()) {
      const match = CHOOSING.exec(entry);
      if (match?.[1] === undefined || match[1] === id) {
        continue;
      }
      const file = path.join(this.dir, entry);
      const owner = this.readRecord<{ pid: number; startTime?: string }>(file);
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

  /** Tickets of live clients, holder first. Tickets of dead clients are removed on the way. */
  private liveTickets(): LeaseInfo[] {
    const live: LeaseInfo[] = [];
    for (const ticket of this.listTickets()) {
      const record = this.readRecord<TicketRecord>(ticket.file);
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

  private readDir(): string[] {
    try {
      return readdirSync(this.dir);
    } catch {
      return [];
    }
  }

  /** Null when the file is gone (released meanwhile) or unreadable. */
  private readRecord<T>(file: string): T | null {
    try {
      return JSON.parse(readFileSync(file, 'utf-8')) as T;
    } catch {
      return null;
    }
  }

  /** Readers never see a half-written file: write aside, then rename. */
  private writeAtomic(file: string, content: object): void {
    const tmp = path.join(this.dir, `.tmp-${path.basename(file)}`);
    writeFileSync(tmp, JSON.stringify(content));
    renameSync(tmp, file);
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
