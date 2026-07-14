import { InvalidLauncherError } from './errors';
import { HealthChecker } from './HealthChecker';
import type { LauncherStatus } from './LauncherStatus';
import type { Logger } from './Logger';
import type { LlmLauncher } from './LlmLauncher';
import type { ProcessController } from './ProcessManager';

export class Orchestrator {
  private readonly launchers = new Map<string, LlmLauncher>();
  private readonly healthChecker: HealthChecker;

  constructor(
    private readonly process: ProcessController,
    private readonly vramCapacityGb: number,
    private readonly logger?: Logger,
    healthChecker?: HealthChecker,
  ) {
    this.healthChecker = healthChecker ?? new HealthChecker();
  }

  addLauncher(launcher: LlmLauncher): void {
    this.launchers.set(launcher.name, launcher);
  }

  getLaunchers(): LlmLauncher[] {
    return [...this.launchers.values()];
  }

  async ensureActive(name: string, waitForHealth = true): Promise<void> {
    const launcher = this.getLauncher(name);

    if (this.process.isActive(launcher)) {
      if (waitForHealth && launcher.health) {
        await this.waitForHealth(launcher);
      }
      return;
    }

    if (!launcher.allowFullCPU) {
      this.stopOtherGpuLaunchers(name);
      this.assertFitsInVram(launcher);
    }

    this.logger?.log(`Starting process ${name}...`);
    this.process.start(launcher);

    if (waitForHealth && launcher.health) {
      await this.waitForHealth(launcher);
    }
  }

  isLauncherActive(name: string): boolean {
    return this.process.isActive(this.getLauncher(name));
  }

  async getLauncherStatus(name: string): Promise<LauncherStatus> {
    const launcher = this.getLauncher(name);

    if (!this.process.isActive(launcher)) {
      return 'inactive';
    }

    if (!launcher.health || (await this.healthChecker.isHealthy(launcher.health))) {
      return 'ready';
    }

    return 'starting';
  }

  stop(name: string): void {
    const launcher = this.getLauncher(name);
    if (!this.process.isActive(launcher)) {
      return;
    }

    this.logger?.log(`Stopping process ${name}...`);
    this.process.stop(launcher);
  }

  async checkSMI(): Promise<string> {
    try {
      const proc = Bun.spawn(['nvidia-smi'], { stdout: 'pipe', stderr: 'ignore' });
      return await new Response(proc.stdout).text();
    } catch {
      return '';
    }
  }

  private getLauncher(name: string): LlmLauncher {
    const launcher = this.launchers.get(name);
    if (!launcher) {
      throw new InvalidLauncherError(`invalid launcher: ${name}`);
    }

    return launcher;
  }

  private stopOtherGpuLaunchers(exceptName: string): void {
    for (const launcher of this.launchers.values()) {
      if (launcher.name === exceptName || launcher.allowFullCPU) {
        continue;
      }
      if (this.process.isActive(launcher)) {
        this.process.stop(launcher);
      }
    }
  }

  private async waitForHealth(launcher: LlmLauncher): Promise<void> {
    const health = launcher.health;
    if (!health) {
      return;
    }

    this.logger?.log(`Waiting for ${launcher.name} to become healthy (${health.url})...`);
    await this.healthChecker.waitUntilHealthy(health, () => this.process.isActive(launcher));
    this.logger?.log(`${launcher.name} is healthy.`);
  }

  private assertFitsInVram(launcher: LlmLauncher): void {
    let usedByOthers = 0;
    for (const other of this.launchers.values()) {
      if (other.allowFullCPU || !this.process.isActive(other)) {
        continue;
      }
      usedByOthers += other.minimalVideoRamUsageInGigabytes;
    }

    const required = usedByOthers + launcher.minimalVideoRamUsageInGigabytes;
    if (required > this.vramCapacityGb) {
      throw new Error(`Not enough VRAM for ${launcher.name}: need ${required}GB, capacity is ${this.vramCapacityGb}GB`);
    }
  }
}
