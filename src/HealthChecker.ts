import type { LauncherHealth } from './LauncherHealth';

export class HealthChecker {
  async isHealthy(health: LauncherHealth): Promise<boolean> {
    try {
      const response = await fetch(health.url, { signal: AbortSignal.timeout(5000) });
      return response.status === health.expectedStatus;
    } catch {
      return false;
    }
  }

  /**
   * Polls until healthy or the timeout elapses.
   * @param isProcessAlive Called between polls; aborts if it returns false.
   */
  async waitUntilHealthy(health: LauncherHealth, isProcessAlive: () => boolean): Promise<void> {
    const deadline = Date.now() + health.timeoutSeconds * 1000;

    while (Date.now() < deadline) {
      if (!isProcessAlive()) {
        throw new Error('Process exited before becoming healthy');
      }

      if (await this.isHealthy(health)) {
        return;
      }

      await Bun.sleep(health.intervalMs);
    }

    throw new Error(`Health check timed out after ${health.timeoutSeconds}s (${health.url})`);
  }
}
