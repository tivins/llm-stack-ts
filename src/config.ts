import { existsSync, readFileSync } from 'node:fs';
import { isLlmType, LLM_TYPES } from './LlmType';
import { StackConfigError } from './errors';
import type { LauncherHealth } from './LauncherHealth';
import type { LlmLauncher } from './LlmLauncher';

export interface StackConfig {
  readonly vramCapacityGb: number;
  readonly launchers: LlmLauncher[];
}

const DEFAULT_HEALTH_TIMEOUT_SECONDS = 300;
const DEFAULT_HEALTH_INTERVAL_MS = 1000;
const DEFAULT_HEALTH_EXPECTED_STATUS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseHealth(conf: Record<string, unknown>, label: string): LauncherHealth | undefined {
  const health = conf.health;
  if (health === undefined) {
    return undefined;
  }
  if (!isRecord(health)) {
    throw new StackConfigError(`${label} health must be an object`);
  }

  const url = health.url;
  if (typeof url !== 'string' || url === '') {
    throw new StackConfigError(`${label} health requires a non-empty url`);
  }

  const timeoutSeconds = health.timeout_seconds ?? DEFAULT_HEALTH_TIMEOUT_SECONDS;
  if (typeof timeoutSeconds !== 'number' || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) {
    throw new StackConfigError(`${label} health timeout_seconds must be a positive integer`);
  }

  const intervalMs = health.interval_ms ?? DEFAULT_HEALTH_INTERVAL_MS;
  if (typeof intervalMs !== 'number' || !Number.isInteger(intervalMs) || intervalMs < 100) {
    throw new StackConfigError(`${label} health interval_ms must be an integer >= 100`);
  }

  const expectedStatus = health.expected_status ?? DEFAULT_HEALTH_EXPECTED_STATUS;
  if (typeof expectedStatus !== 'number' || !Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599) {
    throw new StackConfigError(`${label} health expected_status must be an HTTP status code`);
  }

  return { url, timeoutSeconds, intervalMs, expectedStatus };
}

function parseLauncher(conf: Record<string, unknown>, index: number): LlmLauncher {
  let label = `launchers[${index}]`;

  const name = conf.name;
  if (typeof name !== 'string' || name === '') {
    throw new StackConfigError(`${label} requires a non-empty name`);
  }

  label = `launchers[${index}] (${name})`;

  const typeValue = conf.type;
  if (typeof typeValue !== 'string' || typeValue === '') {
    throw new StackConfigError(`${label} requires a type`);
  }
  if (!isLlmType(typeValue)) {
    throw new StackConfigError(`${label} has invalid type '${typeValue}' (expected: ${LLM_TYPES.join(', ')})`);
  }

  const command = conf.command;
  if (typeof command !== 'string' || command === '') {
    throw new StackConfigError(`${label} requires a command`);
  }

  const description = conf.description;
  if (typeof description !== 'string' || description === '') {
    throw new StackConfigError(`${label} requires a non-empty description`);
  }

  const vram = conf.minimal_video_ram_usage_in_gigabytes;
  if (typeof vram !== 'number') {
    throw new StackConfigError(`${label} requires minimal_video_ram_usage_in_gigabytes`);
  }

  const processMatch = conf.process_match;
  if (processMatch !== undefined && typeof processMatch !== 'string') {
    throw new StackConfigError(`${label} process_match must be a string`);
  }

  return {
    name,
    type: typeValue,
    description,
    commandLine: command,
    minimalVideoRamUsageInGigabytes: vram,
    allowFullCPU: conf.allow_full_cpu === true || conf.allow_full_cpu === 'true' || conf.allow_full_cpu === '1',
    processMatch,
    health: parseHealth(conf, label),
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
  } catch {
    throw new StackConfigError(`invalid JSON in stack file: ${file}`);
  }

  if (!isRecord(parsed)) {
    throw new StackConfigError(`invalid JSON in stack file: ${file}`);
  }

  const vramCapacityGb = parsed.vram_capacity_in_gigabytes;
  if (typeof vramCapacityGb !== 'number' || !Number.isInteger(vramCapacityGb) || vramCapacityGb < 1) {
    throw new StackConfigError(`stack file must contain a positive integer vram_capacity_in_gigabytes: ${file}`);
  }

  const launchersRaw = parsed.launchers;
  if (!Array.isArray(launchersRaw)) {
    throw new StackConfigError(`stack file must contain a launchers array: ${file}`);
  }

  const launchers = launchersRaw.map((conf, index) => {
    if (!isRecord(conf)) {
      throw new StackConfigError(`launchers[${index}] must be an object`);
    }
    return parseLauncher(conf, index);
  });

  return { vramCapacityGb, launchers };
}
