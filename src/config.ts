import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { canonicalLlamaArgs, canonicalLlamaKey, isArgKey, renderArgs, tokenize } from './args';
import type { ArgValue, Args } from './args';
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

export interface LoadOptions {
  /** Extra args per launcher name, merged last (`stack start <name> --arg ctx-size=65536`). */
  readonly argOverrides?: Readonly<Record<string, Args>>;
}

export type LauncherKind = 'command' | 'llama-server';

const DEFAULT_HEALTH_TIMEOUT_SECONDS = 300;
const DEFAULT_HEALTH_INTERVAL_MS = 1000;
const DEFAULT_STOP_TIMEOUT_SECONDS = 10;
export const LLAMA_SERVER_DEFAULT_HOST = '127.0.0.1';
export const LLAMA_SERVER_DEFAULT_PORT = 8080;
const NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_-]*)\}/g;
const KINDS: LauncherKind[] = ['command', 'llama-server'];

const TOP_LEVEL_KEYS = ['$schema', 'vram_capacity_gb', 'vram_capacity_in_gigabytes', 'vars', 'launchers'];
const LAUNCHER_KEYS = [
  'name',
  'extends',
  'abstract',
  'kind',
  'description',
  'type',
  'command',
  'args',
  'host',
  'port',
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
/** Keys merged key by key with the parent's value instead of replacing it. */
const MERGED_KEYS = ['args', 'env', 'health'];
/** Keys that only apply to the launcher declaring them. */
const OWN_KEYS = ['name', 'extends', 'abstract'];

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

function parseHealth(health: unknown, label: string): LauncherHealth | undefined {
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

function parseEnv(env: unknown, label: string): Record<string, string> | undefined {
  if (env === undefined) {
    return undefined;
  }
  if (!isRecord(env) || !Object.values(env).every((v) => typeof v === 'string')) {
    throw new StackConfigError(`${label} env must be an object of string values`);
  }
  return env as Record<string, string>;
}

function isArgValue(value: unknown): value is ArgValue {
  const scalar = (v: unknown) => typeof v === 'string' || typeof v === 'number';
  return scalar(value) || typeof value === 'boolean' || (Array.isArray(value) && value.every(scalar));
}

function parseArgs(args: unknown, label: string): Args {
  if (!isRecord(args)) {
    throw new StackConfigError(`${label} args must be an object`);
  }
  for (const [key, value] of Object.entries(args)) {
    if (!isArgKey(key)) {
      throw new StackConfigError(`${label} args key '${key}' is not a valid option name`);
    }
    if (!isArgValue(value)) {
      throw new StackConfigError(`${label} args.${key} must be a string, number, boolean or array`);
    }
  }
  return args as Args;
}

/** A launcher as written in the file, before `extends` and variables are resolved. */
interface Entry {
  readonly name: string;
  readonly label: string;
  readonly conf: Record<string, unknown>;
}

function collectEntries(launchersRaw: unknown, source: string): Entry[] {
  if (Array.isArray(launchersRaw)) {
    return launchersRaw.map((conf, index) => {
      if (!isRecord(conf)) {
        throw new StackConfigError(`launchers[${index}] must be an object`);
      }
      const name = conf.name;
      if (typeof name !== 'string' || name === '') {
        throw new StackConfigError(`launchers[${index}] requires a non-empty name`);
      }
      return { name, label: `launchers[${index}] (${name})`, conf };
    });
  }

  if (isRecord(launchersRaw)) {
    return Object.entries(launchersRaw).map(([name, conf]) => {
      const label = `launchers.${name}`;
      if (!isRecord(conf)) {
        throw new StackConfigError(`${label} must be a table`);
      }
      if (conf.name !== undefined && conf.name !== name) {
        throw new StackConfigError(`${label} name must match its key`);
      }
      return { name, label, conf };
    });
  }

  throw new StackConfigError(`stack file must contain launchers: ${source}`);
}

/** Resolves `${name}` references; unresolved ones are left in place and reported through `onUnknown`. */
function substitute(value: string, vars: Readonly<Record<string, string>>, onUnknown?: (name: string) => void): string {
  return value.replace(VAR_PATTERN, (match, name: string) => {
    const resolved = vars[name];
    if (resolved === undefined) {
      onUnknown?.(name);
      return match;
    }
    return resolved;
  });
}

function parseVars(raw: unknown, warnings: ConfigWarning[]): Record<string, string> {
  if (raw === undefined) {
    return {};
  }
  if (!isRecord(raw)) {
    throw new StackConfigError('stack file vars must be a table');
  }
  // Each variable may use the ones defined before it.
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new StackConfigError(`vars.${name} must be a string or a number`);
    }
    vars[name] = substitute(String(value), vars, (unknown) =>
      warnings.push({ level: 'warning', message: `vars.${name} references unknown variable '${unknown}'` }),
    );
  }
  return vars;
}

/** The `extends` chain of a launcher, root first. */
function resolveChain(entry: Entry, byName: ReadonlyMap<string, Entry>): Entry[] {
  const chain = [entry];
  const seen = new Set([entry.name]);
  let current = entry;

  while (current.conf.extends !== undefined) {
    const parentName = current.conf.extends;
    if (typeof parentName !== 'string') {
      throw new StackConfigError(`${current.label} extends must be a launcher name`);
    }
    const parent = byName.get(parentName);
    if (!parent) {
      throw new StackConfigError(`${current.label} extends unknown launcher '${parentName}'`);
    }
    if (seen.has(parentName)) {
      throw new StackConfigError(`extends cycle: ${[...chain.map((e) => e.name), parentName].reverse().join(' -> ')}`);
    }
    seen.add(parentName);
    chain.unshift(parent);
    current = parent;
  }
  return chain;
}

function resolveKind(chain: Entry[]): LauncherKind {
  let kind: unknown = 'command';
  for (const entry of chain) {
    if (entry.conf.kind !== undefined) {
      kind = entry.conf.kind;
      if (!KINDS.includes(kind as LauncherKind)) {
        throw new StackConfigError(`${entry.label} kind must be one of: ${KINDS.join(', ')}`);
      }
    }
  }
  return kind as LauncherKind;
}

/** Merges the chain root first: `args`, `env` and `health` key by key, everything else replaced. */
function mergeChain(chain: Entry[], kind: LauncherKind, overrides: Args | undefined): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const layers = chain.map((entry) => ({ conf: entry.conf, label: entry.label }));
  if (overrides !== undefined) {
    layers.push({ conf: { args: overrides }, label: '--arg' });
  }

  for (const { conf, label } of layers) {
    for (const [key, value] of Object.entries(conf)) {
      if (OWN_KEYS.includes(key)) {
        continue;
      }
      if (!MERGED_KEYS.includes(key)) {
        merged[key] = value;
        continue;
      }
      let layer: Record<string, unknown>;
      if (key === 'args') {
        const args = parseArgs(value, label);
        layer = kind === 'llama-server' ? canonicalLlamaArgs(args) : args;
      } else if (key === 'env') {
        layer = parseEnv(value, label) ?? {};
      } else if (isRecord(value)) {
        layer = value;
      } else {
        throw new StackConfigError(`${label} ${key} must be an object`);
      }
      merged[key] = { ...(merged[key] as Record<string, unknown> | undefined), ...layer };
    }
  }
  return merged;
}

function parsePort(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new StackConfigError(`${label} port must be an integer between 1 and 65535`);
  }
  return value;
}

/** Applies variables to every string of the merged launcher; `command` is left to bash for unknown ones. */
function substituteLauncher(
  merged: Record<string, unknown>,
  vars: Readonly<Record<string, string>>,
  label: string,
  warnings: ConfigWarning[],
): void {
  const reported = new Set<string>();
  const warn = (name: string) => {
    if (!reported.has(name)) {
      reported.add(name);
      warnings.push({ level: 'warning', message: `${label} references unknown variable '${name}'` });
    }
  };
  const sub = (value: unknown, onUnknown: (name: string) => void = warn): unknown => {
    if (typeof value === 'string') return substitute(value, vars, onUnknown);
    if (Array.isArray(value)) return value.map((item) => sub(item, onUnknown));
    return value;
  };

  merged.command = sub(merged.command, () => {});
  for (const key of ['cwd', 'process_match', 'description']) {
    merged[key] = sub(merged[key]);
  }
  for (const key of MERGED_KEYS) {
    const table = merged[key];
    if (isRecord(table)) {
      merged[key] = Object.fromEntries(Object.entries(table).map(([k, v]) => [k, sub(v)]));
    }
  }
}

function buildLauncher(
  entry: Entry,
  chain: Entry[],
  globalVars: Readonly<Record<string, string>>,
  overrides: Args | undefined,
  warnings: ConfigWarning[],
): Launcher {
  const { name, label } = entry;
  const kind = resolveKind(chain);
  const conf = mergeChain(chain, kind, overrides);

  const port = parsePort(conf.port, label);
  const host = optionalString(conf, 'host', label);
  if (host === '') {
    throw new StackConfigError(`${label} host must not be empty`);
  }
  const effectiveHost = host ?? (kind === 'llama-server' ? LLAMA_SERVER_DEFAULT_HOST : undefined);
  const effectivePort = port ?? (kind === 'llama-server' ? LLAMA_SERVER_DEFAULT_PORT : undefined);

  const vars: Record<string, string> = { ...globalVars, name };
  if (effectiveHost !== undefined) vars.host = substitute(effectiveHost, globalVars);
  if (effectivePort !== undefined) vars.port = String(effectivePort);
  substituteLauncher(conf, vars, label, warnings);

  let command = conf.command;
  if (command === undefined && kind === 'llama-server') {
    command = 'llama-server';
  }
  if (typeof command !== 'string' || command === '') {
    throw new StackConfigError(`${label} requires a command`);
  }

  const args = (conf.args as Args | undefined) ?? {};
  const parts = [command, ...renderArgs(args)];
  let health = conf.health;

  if (kind === 'llama-server') {
    for (const key of ['host', 'port']) {
      if (args[key] !== undefined) {
        throw new StackConfigError(`${label} sets ${key} in args, use the ${key} key instead`);
      }
    }
    parts.push('--host', vars.host as string, '--port', vars.port as string);
    if (!isRecord(health) || health.url === undefined) {
      // A server listening on every interface is still reachable on loopback.
      const healthHost = vars.host === '0.0.0.0' ? '127.0.0.1' : vars.host;
      health = { ...(health as Record<string, unknown> | undefined), url: `http://${healthHost}:${vars.port}/health` };
    }
  }

  const vram = aliased(conf, 'vram_gb', 'minimal_video_ram_usage_in_gigabytes', label, warnings) ?? 0;
  if (typeof vram !== 'number' || vram < 0) {
    throw new StackConfigError(`${label} vram_gb must be a number >= 0`);
  }

  const cwd = optionalString(conf, 'cwd', label);
  if (cwd === '') {
    throw new StackConfigError(`${label} cwd must not be empty`);
  }

  // Keys come from the launcher's own layer (canonical spelling), values from the resolved args.
  const ownRaw = isRecord(entry.conf.args) ? Object.keys(entry.conf.args) : [];
  const ownArgs: Args = {};
  for (const key of ownRaw) {
    const canonical = kind === 'llama-server' ? canonicalLlamaKey(key) : key;
    const value = args[canonical];
    if (value !== undefined) ownArgs[canonical] = value;
  }

  return {
    name,
    extends: typeof entry.conf.extends === 'string' ? entry.conf.extends : undefined,
    kind,
    port: effectivePort,
    args,
    ownArgs,
    description: optionalString(conf, 'description', label) ?? '',
    type: optionalString(conf, 'type', label) ?? '',
    commandLine: parts.join(' '),
    cwd: cwd === undefined ? undefined : expandHome(cwd),
    env: parseEnv(conf.env, label),
    vramGb: vram,
    ...parseGpuFlags(conf, label, warnings),
    processMatch: optionalString(conf, 'process_match', label),
    stopTimeoutSeconds: positiveInteger(
      conf.stop_timeout_seconds,
      DEFAULT_STOP_TIMEOUT_SECONDS,
      1,
      `${label} stop_timeout_seconds must be a positive integer`,
    ),
    health: parseHealth(health, label),
  };
}

/** Builds the launchers from an already parsed stack file (JSON or TOML document). */
export function parseStackConfig(parsed: unknown, source: string, options: LoadOptions = {}): StackConfig {
  if (!isRecord(parsed)) {
    throw new StackConfigError(`stack file must contain an object: ${source}`);
  }

  const warnings: ConfigWarning[] = [];
  warnUnknownKeys(parsed, TOP_LEVEL_KEYS, 'stack file', warnings);

  const vramCapacityGb = aliased(parsed, 'vram_capacity_gb', 'vram_capacity_in_gigabytes', 'stack file', warnings);
  if (vramCapacityGb !== undefined && (typeof vramCapacityGb !== 'number' || vramCapacityGb <= 0)) {
    throw new StackConfigError(`stack file vram_capacity_gb must be a positive number: ${source}`);
  }

  const vars = parseVars(parsed.vars, warnings);
  const entries = collectEntries(parsed.launchers, source);

  const byName = new Map<string, Entry>();
  entries.forEach((entry, index) => {
    if (!NAME_PATTERN.test(entry.name)) {
      throw new StackConfigError(`${entry.label} name '${entry.name}' may only contain letters, digits, '.', '_' and '-'`);
    }
    if (byName.has(entry.name)) {
      throw new StackConfigError(`launchers[${index}] duplicates the name '${entry.name}'`);
    }
    byName.set(entry.name, entry);
    warnUnknownKeys(entry.conf, LAUNCHER_KEYS, entry.label, warnings);
    if (isRecord(entry.conf.health)) {
      warnUnknownKeys(entry.conf.health, HEALTH_KEYS, `${entry.label} health`, warnings);
    }
    if (entry.conf.abstract !== undefined && typeof entry.conf.abstract !== 'boolean') {
      throw new StackConfigError(`${entry.label} abstract must be true or false`);
    }
  });

  const launchers = entries
    .filter((entry) => entry.conf.abstract !== true)
    .map((entry) => buildLauncher(entry, resolveChain(entry, byName), vars, options.argOverrides?.[entry.name], warnings));

  // A parent's legacy key is reported once per child; keep each message once.
  const unique = [...new Map(warnings.map((w) => [`${w.level}:${w.message}`, w])).values()];
  return { vramCapacityGb, launchers, warnings: unique };
}

/** Reads a stack file as TOML (`.toml`) or JSON (anything else). */
export function readStackFile(file: string): unknown {
  if (!existsSync(file)) {
    throw new StackConfigError(`stack file not found or not readable: ${file}`);
  }
  const content = readFileSync(file, 'utf-8');
  const isToml = path.extname(file).toLowerCase() === '.toml';
  try {
    return isToml ? Bun.TOML.parse(content) : JSON.parse(content);
  } catch (err) {
    const detail = err instanceof Error ? ` (${err.message})` : '';
    throw new StackConfigError(`invalid ${isToml ? 'TOML' : 'JSON'} in stack file: ${file}${detail}`);
  }
}

const STACK_FILE_NAMES = ['stack.toml', 'stack.json'];

/** Resolves the stack file: explicit path, then $LLM_STACK_CONFIG, then ./stack.toml or ./stack.json, then a fallback directory. */
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

  const dirs = fallbackDir ? [process.cwd(), fallbackDir] : [process.cwd()];
  const candidates = dirs.flatMap((dir) => STACK_FILE_NAMES.map((name) => `${dir}/${name}`));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new StackConfigError(
    `no stack file found\n${candidates.map((c) => `  Searched: ${c}`).join('\n')}\n  Hint: use -f /path/to/stack.toml or set LLM_STACK_CONFIG`,
  );
}

export function loadStackConfig(file: string, options: LoadOptions = {}): StackConfig {
  return parseStackConfig(readStackFile(file), file, options);
}

/** Absolute paths used by a launcher (cwd, and path-like command line arguments) that do not exist. */
export function findMissingPaths(launcher: Launcher): string[] {
  const tokens = tokenize(launcher.commandLine) ?? launcher.commandLine.split(/\s+/);
  const candidates = tokens.filter((token) => token.startsWith('/') && !token.includes('$'));
  if (launcher.cwd !== undefined) {
    candidates.unshift(launcher.cwd);
  }
  return [...new Set(candidates)].filter((candidate) => !existsSync(candidate));
}
