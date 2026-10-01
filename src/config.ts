import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { StackConfigError } from './errors';
import type { Launcher } from './Launcher';
import type { LauncherHealth } from './LauncherHealth';

export interface ConfigWarning {
  /** `deprecation` flags legacy keys that still work; `warning` flags likely mistakes. */
  readonly level: 'warning' | 'deprecation';
  readonly message: string;
}

export interface StackConfig {
  /** Total VRAM available to `gpu` launchers; no budget check when unset. */
  readonly vramCapacityGb?: number;
  readonly launchers: Launcher[];
  readonly warnings: ConfigWarning[];
}

const DEFAULT_HEALTH_TIMEOUT_SECONDS = 300;
const DEFAULT_HEALTH_INTERVAL_MS = 1000;
const DEFAULT_STOP_TIMEOUT_SECONDS = 10;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const TOP_LEVEL_KEYS = ['$schema', 'vram_capacity_gb', 'vram_capacity_in_gigabytes', 'launchers'];
const LAUNCHER_KEYS = [
  'name',
  'description',
  'type',
  'command',
  'cwd',
  'env',
  'vram_gb',
  'minimal_video_ram_usage_in_gigabytes',
  'gpu',
  'exclusive',
  'allow_full_cpu',
  'process_match',
  'stop_timeout_seconds',
  'health',
];
const HEALTH_KEYS = ['url', 'timeout_seconds', 'interval_ms', 'expected_status'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function warnUnknownKeys(conf: Record<string, unknown>, known: string[], label: string, warnings: ConfigWarning[]): void {
  for (const key of Object.keys(conf)) {
    if (!known.includes(key)) {
      warnings.push({ level: 'warning', message: `${label} has unknown key '${key}' (ignored)` });
    }
  }
}

function optionalString(conf: Record<string, unknown>, key: string, label: string): string | undefined {
  const value = conf[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new StackConfigError(`${label} ${key} must be a string`);
  }
  return value;
}

function optionalBoolean(conf: Record<string, unknown>, key: string, label: string): boolean | undefined {
  const value = conf[key];
  if (value !== undefined && typeof value !== 'boolean') {
    throw new StackConfigError(`${label} ${key} must be true or false`);
  }
  return value;
}

function positiveInteger(value: unknown, fallback: number, min: number, message: string): number {
  const result = value ?? fallback;
  if (typeof result !== 'number' || !Number.isInteger(result) || result < min) {
    throw new StackConfigError(message);
  }
  return result;
}

/** Reads a value that may be given under its current key or a legacy alias (never both). */
function aliased(
  conf: Record<string, unknown>,
  key: string,
  legacyKey: string,
  label: string,
  warnings: ConfigWarning[],
): unknown {
  if (conf[legacyKey] === undefined) {
    return conf[key];
  }
  if (conf[key] !== undefined) {
    throw new StackConfigError(`${label} cannot set both ${key} and ${legacyKey}`);
  }
  warnings.push({ level: 'deprecation', message: `${label} ${legacyKey} is deprecated, use ${key}` });
  return conf[legacyKey];
}

function expandHome(dir: string): string {
  return dir === '~' || dir.startsWith('~/') ? homedir() + dir.slice(1) : dir;
}

function parseHealth(conf: Record<string, unknown>, label: string, warnings: ConfigWarning[]): LauncherHealth | undefined {
  const health = conf.health;
  if (health === undefined) {
    return undefined;
  }
  if (!isRecord(health)) {
    throw new StackConfigError(`${label} health must be an object`);
  }
  warnUnknownKeys(health, HEALTH_KEYS, `${label} health`, warnings);

  const url = health.url;
  if (typeof url !== 'string' || url === '') {
    throw new StackConfigError(`${label} health requires a non-empty url`);
  }
  if (!URL.canParse(url)) {
    throw new StackConfigError(`${label} health url is not a valid URL: ${url}`);
  }

  const timeoutSeconds = positiveInteger(
    health.timeout_seconds,
    DEFAULT_HEALTH_TIMEOUT_SECONDS,
    1,
    `${label} health timeout_seconds must be a positive integer`,
  );
  const intervalMs = positiveInteger(
    health.interval_ms,
    DEFAULT_HEALTH_INTERVAL_MS,
    100,
    `${label} health interval_ms must be an integer >= 100`,
  );

  const expectedStatus = health.expected_status;
  if (
    expectedStatus !== undefined &&
    (typeof expectedStatus !== 'number' || !Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599)
  ) {
    throw new StackConfigError(`${label} health expected_status must be an HTTP status code`);
  }

  return { url, timeoutSeconds, intervalMs, expectedStatus };
}

/** Resolves `gpu`/`exclusive`, mapping the legacy `allow_full_cpu` flag (true = neither, false = both). */
function parseGpuFlags(conf: Record<string, unknown>, label: string, warnings: ConfigWarning[]): { gpu: boolean; exclusive: boolean } {
  const gpu = optionalBoolean(conf, 'gpu', label);
  const exclusive = optionalBoolean(conf, 'exclusive', label);
  const legacy = conf.allow_full_cpu;

  if (legacy === undefined) {
    return { gpu: gpu ?? true, exclusive: exclusive ?? gpu ?? true };
  }
  if (gpu !== undefined || exclusive !== undefined) {
    throw new StackConfigError(`${label} cannot combine allow_full_cpu with gpu/exclusive`);
  }
  warnings.push({ level: 'deprecation', message: `${label} allow_full_cpu is deprecated, use gpu and exclusive` });

  // The PHP original accepted "true"/"1" strings, kept for compatibility.
  const cpuOnly = legacy === true || legacy === 'true' || legacy === '1';
  return { gpu: !cpuOnly, exclusive: !cpuOnly };
}

function parseEnv(conf: Record<string, unknown>, label: string): Record<string, string> | undefined {
  const env = conf.env;
  if (env === undefined) {
    return undefined;
  }
  if (!isRecord(env) || !Object.values(env).every((v) => typeof v === 'string')) {
    throw new StackConfigError(`${label} env must be an object of string values`);
  }
  return env as Record<string, string>;
}

function parseLauncher(conf: Record<string, unknown>, index: number, warnings: ConfigWarning[]): Launcher {
  let label = `launchers[${index}]`;

  const name = conf.name;
  if (typeof name !== 'string' || name === '') {
    throw new StackConfigError(`${label} requires a non-empty name`);
  }
  if (!NAME_PATTERN.test(name)) {
    throw new StackConfigError(`${label} name '${name}' may only contain letters, digits, '.', '_' and '-'`);
  }

  label = `launchers[${index}] (${name})`;
  warnUnknownKeys(conf, LAUNCHER_KEYS, label, warnings);

  const command = conf.command;
  if (typeof command !== 'string' || command === '') {
    throw new StackConfigError(`${label} requires a command`);
  }

  const vram = aliased(conf, 'vram_gb', 'minimal_video_ram_usage_in_gigabytes', label, warnings) ?? 0;
  if (typeof vram !== 'number' || vram < 0) {
    throw new StackConfigError(`${label} vram_gb must be a number >= 0`);
  }

  const cwd = optionalString(conf, 'cwd', label);
  if (cwd === '') {
    throw new StackConfigError(`${label} cwd must not be empty`);
  }

  return {
    name,
    description: optionalString(conf, 'description', label) ?? '',
    type: optionalString(conf, 'type', label) ?? '',
    commandLine: command,
    cwd: cwd === undefined ? undefined : expandHome(cwd),
    env: parseEnv(conf, label),
    vramGb: vram,
    ...parseGpuFlags(conf, label, warnings),
    processMatch: optionalString(conf, 'process_match', label),
    stopTimeoutSeconds: positiveInteger(
      conf.stop_timeout_seconds,
      DEFAULT_STOP_TIMEOUT_SECONDS,
      1,
      `${label} stop_timeout_seconds must be a positive integer`,
    ),
    health: parseHealth(conf, label, warnings),
  };
}

/** Resolves the stack.json path: explicit path, then $LLM_STACK_CONFIG, then ./stack.json, then a fallback directory. */
export function resolveStackFile(explicitPath?: string, fallbackDir?: string): string {
  if (explicitPath !== undefined) {
    if (explicitPath === '') {
      throw new StackConfigError('-f requires a file path');
    }
    if (!existsSync(explicitPath)) {
      throw new StackConfigError(`stack file not found or not readable: ${explicitPath}`);
    }
    return explicitPath;
  }

  const fromEnv = process.env.LLM_STACK_CONFIG;
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new StackConfigError(`stack file not found or not readable: ${fromEnv} (from LLM_STACK_CONFIG)`);
    }
    return fromEnv;
  }

  const candidates = [`${process.cwd()}/stack.json`];
  if (fallbackDir) {
    candidates.push(`${fallbackDir}/stack.json`);
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new StackConfigError(
    `no stack.json found\n${candidates.map((c) => `  Searched: ${c}`).join('\n')}\n  Hint: use -f /path/to/stack.json or set LLM_STACK_CONFIG`,
  );
}

export function loadStackConfig(file: string): StackConfig {
  if (!existsSync(file)) {
    throw new StackConfigError(`stack file not found or not readable: ${file}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    const detail = err instanceof Error ? ` (${err.message})` : '';
    throw new StackConfigError(`invalid JSON in stack file: ${file}${detail}`);
  }

  if (!isRecord(parsed)) {
    throw new StackConfigError(`stack file must contain a JSON object: ${file}`);
  }

  const warnings: ConfigWarning[] = [];
  warnUnknownKeys(parsed, TOP_LEVEL_KEYS, 'stack file', warnings);

  const vramCapacityGb = aliased(parsed, 'vram_capacity_gb', 'vram_capacity_in_gigabytes', 'stack file', warnings);
  if (vramCapacityGb !== undefined && (typeof vramCapacityGb !== 'number' || vramCapacityGb <= 0)) {
    throw new StackConfigError(`stack file vram_capacity_gb must be a positive number: ${file}`);
  }

  const launchersRaw = parsed.launchers;
  if (!Array.isArray(launchersRaw)) {
    throw new StackConfigError(`stack file must contain a launchers array: ${file}`);
  }

  const seen = new Set<string>();
  const launchers = launchersRaw.map((conf, index) => {
    if (!isRecord(conf)) {
      throw new StackConfigError(`launchers[${index}] must be an object`);
    }
    const launcher = parseLauncher(conf, index, warnings);
    if (seen.has(launcher.name)) {
      throw new StackConfigError(`launchers[${index}] duplicates the name '${launcher.name}'`);
    }
    seen.add(launcher.name);
    return launcher;
  });

  return { vramCapacityGb, launchers, warnings };
}
