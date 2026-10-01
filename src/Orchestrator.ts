import { InvalidLauncherError, ProcessExitedError } from './errors';
import { HealthChecker } from './HealthChecker';
import type { Launcher } from './Launcher';
import type { LauncherStatus } from './LauncherStatus';
import type { Logger } from './Logger';
import { readLastLines } from './logs';
import type { ProcessController, ProcessExit, StartedProcess } from './ProcessManager';

/** How long a launcher without health check must survive after start to be considered started. */
const STARTUP_GRACE_MS = 500;
const LOG_LINES_ON_FAILURE = 20;

function formatGb(value: number): string {
  return `${Number(value.toFixed(2))}GB`;
}

export class Orchestrator {
  private readonly launchers = new Map<string, Launcher>();
  private readonly healthChecker: HealthChecker;

  constructor(
    private readonly process: ProcessController,
    /** No VRAM budget check when undefined. */
    private readonly vramCapacityGb: number | undefined,
    private readonly logger?: Logger,
    healthChecker?: HealthChecker,
  ) {
    this.healthChecker = healthChecker ?? new HealthChecker();
  }

  addLauncher(launcher: Launcher): void {
    this.launchers.set(launcher.name, launcher);
  }

  getLaunchers(): Launcher[] {
    return [...this.launchers.values()];
  }

  getLauncher(name: string): Launcher {
    const launcher = this.launchers.get(name);
    if (!launcher) {
      throw new InvalidLauncherError(`invalid launcher: ${name}`);
    }

    return launcher;
  }

  async ensureActive(name: string, waitForHealth = true): Promise<void> {
    const launcher = this.getLauncher(name);

    if (this.process.isActive(launcher)) {
      if (waitForHealth && launcher.health) {
        await this.waitForHealth(launcher, () => this.process.isActive(launcher));
      }
      return;
    }

    const toStop = launcher.exclusive
      ? this.activeLaunchers().filter((other) => other.name !== name && other.exclusive)
      : [];
    // Checked before stopping anything, so a refused start leaves the stack untouched.
    this.assertFitsInVram(launcher, toStop);

    for (const other of toStop) {
      this.logger?.log(`Stopping ${other.name} (exclusive)...`);
      this.process.stop(other);
    }

    this.logger?.log(`Starting ${name}...`);
    const started = this.process.start(launcher);
    const logFile = this.process.logFile?.(launcher);
    this.logger?.log(`  pid ${started.pid}${logFile ? `, log: ${logFile}` : ''}`);

    if (waitForHealth) {
      await this.waitForStartup(launcher, started);
    }
  }

  isLauncherActive(name: string): boolean {
    return this.process.isActive(this.getLauncher(name));
  }

  getLauncherPid(name: string): number | null {
    return this.process.getPid(this.getLauncher(name));
  }

  getLauncherLogFile(name: string): string | undefined {
    return this.process.logFile?.(this.getLauncher(name));
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

    this.logger?.log(`Stopping ${name}...`);
    this.process.stop(launcher);
  }

  stopAll(): void {
    for (const launcher of this.launchers.values()) {
      this.stop(launcher.name);
    }
  }

  async checkSMI(): Promise<string> {
    try {
      const proc = Bun.spawn(['nvidia-smi'], { stdout: 'pipe', stderr: 'ignore' });
      return await new Response(proc.stdout).text();
    } catch {
      return '';
    }
  }

  private activeLaunchers(): Launcher[] {
    return [...this.launchers.values()].filter((launcher) => this.process.isActive(launcher));
  }

  /** Waits for a freshly started process: health check if configured, otherwise a short survival check. */
  private async waitForStartup(launcher: Launcher, started: StartedProcess): Promise<void> {
    let exit: ProcessExit | undefined;
    void started.exited.then((result) => {
      exit = result;
    });
    const isAlive = () => exit === undefined && this.process.isActive(launcher);

    try {
      if (launcher.health) {
        await this.waitForHealth(launcher, isAlive);
      } else {
        await Bun.sleep(STARTUP_GRACE_MS);
        if (!isAlive()) {
          throw new ProcessExitedError('Process exited right after start');
        }
      }
    } catch (err) {
      if (!(err instanceof ProcessExitedError)) {
        throw new Error(this.withLogTail(launcher, err instanceof Error ? err.message : String(err)));
      }
      // The exit may be observed through /proc slightly before the promise settles.
      exit ??= await Promise.race([started.exited, Bun.sleep(500).then(() => undefined)]);
      throw new ProcessExitedError(this.withLogTail(launcher, `${launcher.name} ${this.describeExit(exit)} before becoming ready`));
    }
  }

  private async waitForHealth(launcher: Launcher, isAlive: () => boolean): Promise<void> {
    const health = launcher.health;
    if (!health) {
      return;
    }

    this.logger?.log(`Waiting for ${launcher.name} to become healthy (${health.url})...`);
    await this.healthChecker.waitUntilHealthy(health, isAlive);
    this.logger?.log(`${launcher.name} is healthy.`);
  }

  private describeExit(exit: ProcessExit | undefined): string {
    if (exit?.signal) {
      return `was killed by ${exit.signal}`;
    }
    if (exit?.code !== undefined && exit.code !== null) {
      return `exited with code ${exit.code}`;
    }
    return 'exited';
  }

  private withLogTail(launcher: Launcher, message: string): string {
    const logFile = this.process.logFile?.(launcher);
    if (!logFile) {
      return message;
    }

    const lines = readLastLines(logFile, LOG_LINES_ON_FAILURE);
    if (lines.length === 0) {
      return `${message}\nLog file is empty: ${logFile}`;
    }
    return `${message}\nLast lines of ${logFile}:\n${lines.map((line) => `  | ${line}`).join('\n')}`;
  }

  private assertFitsInVram(launcher: Launcher, stopping: Launcher[]): void {
    if (!launcher.gpu || this.vramCapacityGb === undefined) {
      return;
    }

    const users = this.activeLaunchers().filter(
      (other) => other.gpu && other.name !== launcher.name && !stopping.includes(other),
    );
    const usedByOthers = users.reduce((sum, other) => sum + other.vramGb, 0);

    if (usedByOthers + launcher.vramGb > this.vramCapacityGb) {
      const usedBy = users.length > 0 ? `, ${formatGb(usedByOthers)} used by ${users.map((u) => u.name).join(', ')}` : '';
      throw new Error(
        `Not enough VRAM for ${launcher.name}: needs ${formatGb(launcher.vramGb)}${usedBy} (capacity ${formatGb(this.vramCapacityGb)})`,
      );
    }
  }
}
