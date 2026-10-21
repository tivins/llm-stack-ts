import { describeLease } from './GpuLock';
import type { GpuStatus } from './GpuLock';

export class InvalidLauncherError extends Error {}

export class StackConfigError extends Error {}

export class ProcessExitedError extends Error {}

/** The GPU lease was broken by another client (`stack gpu release --force`) or released already. */
export class GpuLeaseLostError extends Error {}

/** `maxWait` elapsed before the GPU lease was granted. Carries who held the GPU and who waited. */
export class GpuBusyError extends Error {
  constructor(
    /** Holder text of the client that gave up. */
    readonly holder: string,
    readonly status: GpuStatus,
  ) {
    const held = status.holder === null ? 'GPU busy' : `GPU held by ${describeLease(status.holder)}`;
    super(`${held}, ${holder} gave up waiting (${status.waiting.length} other client(s) waiting)`);
  }
}
