import { ProcessExitedError } from './errors';
import type { LauncherHealth } from './LauncherHealth';
import { sleep } from './sleep';

export class HealthChecker {
  async isHealthy(health: LauncherHealth, signal?: AbortSignal): Promise<boolean> {
    const timeout = AbortSignal.timeout(5000);
    try {
      const response = await fetch(health.url, { signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
      await response.body?.cancel();
      return health.expectedStatus === undefined ? response.ok : response.status === health.expectedStatus;
    } catch {
      return false;
    }
  }

  /**
   * Polls until healthy or the timeout elapses.
   * @param isProcessAlive Called between polls; aborts if it returns false.
   * @param signal Stops polling: rejects with the signal's reason.
   */
  async waitUntilHealthy(health: LauncherHealth, isProcessAlive: () => boolean, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + health.timeoutSeconds * 1000;

    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (!isProcessAlive()) {
        throw new ProcessExitedError('Process exited before becoming healthy');
      }

      if (await this.isHealthy(health, signal)) {
        return;
      }

      await sleep(health.intervalMs, signal);
    }

    throw new Error(`Health check timed out after ${health.timeoutSeconds}s (${health.url})`);
  }
}
