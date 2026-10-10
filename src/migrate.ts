import { homedir } from 'node:os';
import path from 'node:path';
import { canonicalLlamaArgs, expandHome, parseArgTokens, tokenize } from './args';
import type { ArgValue, Args } from './args';
import { LLAMA_SERVER_DEFAULT_HOST, LLAMA_SERVER_DEFAULT_PORT, parseStackConfig } from './config';
import { StackConfigError } from './errors';
import type { Launcher } from './Launcher';

export interface MigrateOptions {
  /** Shown in the header comment. */
  readonly sourceFile?: string;
  /** Written as a `#:schema` directive for editor completion (Taplo / Even Better TOML). */
  readonly schemaPath?: string;
}

export interface MigrationResult {
  readonly toml: string;
  /** Launchers that would not behave the same after migration; the output must not be used when non-empty. */
  readonly mismatches: string[];
  /** Behaviour changes and dropped keys worth telling the user about. */
  readonly notes: string[];
}

/** Fields copied from a legacy launcher, in output order (`args` and tables come last). */
const FIELD_ORDER = [
  'extends',
  'abstract',
  'kind',
  'command',
  'description',
  'type',
  'cwd',
  'host',
  'port',
  'vram_gb',
  'gpu',
  'exclusive',
  'process_match',
  'stop_timeout_seconds',
  'env',
  'health',
];
const COPIED_FIELDS = ['command', 'description', 'type', 'cwd', 'env', 'vram_gb', 'gpu', 'exclusive', 'process_match', 'stop_timeout_seconds', 'health'];

/** Values a child can set to cancel a parent's field; fields missing here cannot be unset. */
const FIELD_DEFAULTS: Record<string, unknown> = {
  command: 'llama-server',
  description: '',
  type: '',
  host: LLAMA_SERVER_DEFAULT_HOST,
  port: LLAMA_SERVER_DEFAULT_PORT,
  vram_gb: 0,
  gpu: true,
  stop_timeout_seconds: 10,
};

interface Draft {
  readonly name: string;
  fields: Record<string, unknown>;
  /** Set for llama-server launchers. */
  args?: Args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && deepEqual(a[key], b[key]));
  }
  return false;
}

/** "16384" → 16384, but "1.0" stays a string so the rendered command is unchanged. */
function toArgScalar(value: string): string | number {
  const asNumber = Number(value);
  if (value !== '' && Number.isFinite(asNumber) && String(asNumber) === value) {
    return asNumber;
  }
  const home = homedir();
  return value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value;
}

function toArgValue(value: ArgValue): ArgValue {
  if (typeof value === 'string') return toArgScalar(value);
  if (Array.isArray(value)) return value.map((item) => (typeof item === 'string' ? toArgScalar(item) : item));
  return value;
}

function healthHost(host: unknown): string {
  const value = typeof host === 'string' ? host : LLAMA_SERVER_DEFAULT_HOST;
  return value === '0.0.0.0' ? '127.0.0.1' : value;
}

/** Splits a legacy `llama-server ...` command into binary, host, port and args; null if it uses anything args cannot express. */
function parseLlamaCommand(command: string): { binary: string; args: Args; host?: string; port?: number } | null {
  const tokens = tokenize(command);
  if (tokens === null || tokens.length === 0 || path.basename(tokens[0] as string) !== 'llama-server') {
    return null;
  }
  const parsed = parseArgTokens(tokens.slice(1));
  if (parsed === null) {
    return null;
  }
  const args = canonicalLlamaArgs(parsed);
  const { host, port } = args;
  if ((host !== undefined && typeof host !== 'string') || (port !== undefined && !/^\d+$/.test(String(port)))) {
    return null;
  }
  delete args.host;
  delete args.port;

  const converted: Args = {};
  for (const [key, value] of Object.entries(args)) {
    converted[key] = toArgValue(value);
  }
  return { binary: tokens[0] as string, args: converted, host, port: port === undefined ? undefined : Number(port) };
}

function draftFromLegacy(conf: Record<string, unknown>, notes: string[]): Draft {
  const name = conf.name as string;
  const fields: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(conf)) {
    if (key === 'name') continue;
    if (key === 'minimal_video_ram_usage_in_gigabytes') {
      fields.vram_gb = value;
    } else if (key === 'allow_full_cpu') {
      if (value === true || value === 'true' || value === '1') fields.gpu = false;
    } else if (COPIED_FIELDS.includes(key)) {
      fields[key] = value;
    } else {
      notes.push(`${name}: unknown key '${key}' dropped`);
    }
  }

  const llama = typeof fields.command === 'string' ? parseLlamaCommand(fields.command) : null;
  if (llama === null) {
    return { name, fields };
  }

  fields.kind = 'llama-server';
  if (llama.binary === 'llama-server') {
    delete fields.command;
  } else {
    fields.command = llama.binary;
  }
  if (llama.host !== undefined && llama.host !== LLAMA_SERVER_DEFAULT_HOST) fields.host = llama.host;
  if (llama.port !== undefined && llama.port !== LLAMA_SERVER_DEFAULT_PORT) fields.port = llama.port;

  const derivedUrl = `http://${healthHost(fields.host)}:${fields.port ?? LLAMA_SERVER_DEFAULT_PORT}/health`;
  if (isRecord(fields.health)) {
    if (fields.health.url === derivedUrl) {
      const { url: _url, ...rest } = fields.health;
      if (Object.keys(rest).length === 0) {
        delete fields.health;
      } else {
        fields.health = rest;
      }
    }
  } else {
    notes.push(`${name}: health check added (${derivedUrl}), \`start\` now waits for it`);
  }

  return { name, fields, args: llama.args };
}

/** Longest common directory of absolute paths, by path segment. */
function commonDirectory(paths: string[]): string | undefined {
  const split = paths.map((p) => path.dirname(p).split('/'));
  const first = split[0];
  if (first === undefined) return undefined;
  let length = first.length;
  for (const parts of split) {
    let i = 0;
    while (i < length && parts[i] === first[i]) i++;
    length = i;
  }
  const dir = first.slice(0, length).join('/');
  // "/data" alone is too generic to be worth a variable.
  return length >= 3 ? dir : undefined;
}

function mapArgStrings(args: Args, fn: (value: string) => string): Args {
  const result: Args = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') result[key] = fn(value);
    else if (Array.isArray(value)) result[key] = value.map((item) => (typeof item === 'string' ? fn(item) : item));
    else result[key] = value;
  }
  return result;
}

/** Extracts the llama-server binary and the models directory into `vars`. */
function extractVars(llamas: Draft[]): Record<string, string> {
  const vars: Record<string, string> = {};

  const binaries = new Set(llamas.map((d) => d.fields.command));
  const [binary] = binaries;
  if (llamas.length >= 2 && binaries.size === 1 && typeof binary === 'string') {
    vars.llama_server = binary;
    for (const draft of llamas) draft.fields.command = '${llama_server}';
  }

  const models = llamas.map((d) => d.args?.model).filter((m): m is string => typeof m === 'string' && m.startsWith('/'));
  const dir = models.length >= 2 ? commonDirectory(models) : undefined;
  if (dir !== undefined) {
    vars.models = dir;
    for (const draft of llamas) {
      draft.args = mapArgStrings(draft.args ?? {}, (value) => (value.startsWith(`${dir}/`) ? `\${models}${value.slice(dir.length)}` : value));
    }
  }
  return vars;
}

/** What a child must declare to turn `parent` into `child`; null when a parent field cannot be unset. */
function diffDraft(parent: Draft, child: Draft): Record<string, unknown> | null {
  const fields: Record<string, unknown> = { extends: parent.name };

  for (const key of new Set([...Object.keys(parent.fields), ...Object.keys(child.fields)])) {
    const mine = child.fields[key];
    const theirs = parent.fields[key];
    if (deepEqual(mine, theirs)) continue;

    if (mine === undefined) {
      if (key === 'exclusive') {
        fields.exclusive = child.fields.gpu ?? true;
      } else if (key in FIELD_DEFAULTS) {
        fields[key] = FIELD_DEFAULTS[key];
      } else {
        return null;
      }
    } else if (isRecord(mine) && isRecord(theirs)) {
      // env and health merge key by key: a parent key cannot be removed.
      if (!Object.keys(theirs).every((k) => k in mine)) return null;
      fields[key] = Object.fromEntries(Object.entries(mine).filter(([k, v]) => !deepEqual(v, theirs[k])));
    } else {
      fields[key] = mine;
    }
  }

  const args: Args = {};
  for (const [key, value] of Object.entries(child.args ?? {})) {
    if (!deepEqual(value, parent.args?.[key])) args[key] = value;
  }
  for (const key of Object.keys(parent.args ?? {})) {
    if (child.args?.[key] === undefined) args[key] = false;
  }
  if (Object.keys(args).length > 0) fields.args = args;

  return fields;
}

/** Turns the second and later launchers using the same model into variants of the first one. */
function groupVariants(llamas: Draft[]): { roots: Draft[]; variants: Map<string, Record<string, unknown>> } {
  const byModel = new Map<string, Draft>();
  const roots: Draft[] = [];
  const variants = new Map<string, Record<string, unknown>>();

  for (const draft of llamas) {
    const model = draft.args?.model;
    const parent = typeof model === 'string' ? byModel.get(model) : undefined;
    const diff = parent ? diffDraft(parent, draft) : null;
    if (diff !== null) {
      variants.set(draft.name, diff);
      continue;
    }
    roots.push(draft);
    if (typeof model === 'string' && !byModel.has(model)) byModel.set(model, draft);
  }
  return { roots, variants };
}

/** Moves what every root of a same-port group shares into an abstract base launcher. */
function extractBases(roots: Draft[], takenNames: Set<string>): Draft[] {
  const byPort = new Map<number, Draft[]>();
  for (const draft of roots) {
    const port = (draft.fields.port as number | undefined) ?? LLAMA_SERVER_DEFAULT_PORT;
    byPort.set(port, [...(byPort.get(port) ?? []), draft]);
  }
  const groups = [...byPort.entries()].filter(([, group]) => group.length >= 2);

  const bases: Draft[] = [];
  for (const [port, group] of groups) {
    const [first, ...rest] = group as [Draft, ...Draft[]];
    const shared = (a: Record<string, unknown>, others: Record<string, unknown>[]) =>
      Object.keys(a).filter((key) => a[key] !== undefined && others.every((o) => deepEqual(o[key], a[key])));

    const fieldKeys = shared(first.fields, rest.map((d) => d.fields)).filter((key) => key !== 'kind');
    const argKeys = shared(first.args ?? {}, rest.map((d) => d.args ?? {}));
    if (fieldKeys.length === 0 && argKeys.length === 0) continue;

    let name = groups.length === 1 ? '_llama' : `_llama_${port}`;
    while (takenNames.has(name)) name = `_${name}`;
    takenNames.add(name);

    const base: Draft = {
      name,
      fields: { abstract: true, kind: 'llama-server', ...Object.fromEntries(fieldKeys.map((k) => [k, first.fields[k]])) },
      args: Object.fromEntries(argKeys.map((k) => [k, (first.args as Args)[k] as ArgValue])),
    };
    bases.push(base);

    for (const draft of group) {
      const fields: Record<string, unknown> = { extends: name };
      for (const [key, value] of Object.entries(draft.fields)) {
        if (key !== 'kind' && !fieldKeys.includes(key)) fields[key] = value;
      }
      draft.fields = fields;
      draft.args = Object.fromEntries(Object.entries(draft.args ?? {}).filter(([k]) => !argKeys.includes(k)));
    }
  }
  return bases;
}

// --- TOML output -------------------------------------------------------------

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const MAX_INLINE_LENGTH = 100;

function tomlKey(key: string): string {
  return BARE_KEY.test(key) ? key : JSON.stringify(key);
}

function tomlValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value).map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`);
    return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
  }
  throw new StackConfigError(`cannot write ${typeof value} to TOML`);
}

function tomlTable(header: string, fields: Record<string, unknown>): string {
  const lines = [`[${header}]`];
  const subTables: string[] = [];
  const ordered = [...FIELD_ORDER.filter((k) => k in fields), ...Object.keys(fields).filter((k) => !FIELD_ORDER.includes(k))];

  for (const key of ordered) {
    const value = fields[key];
    if (value === undefined) continue;
    const line = `${tomlKey(key)} = ${tomlValue(value)}`;
    if (isRecord(value) && Object.keys(value).length > 0 && line.length > MAX_INLINE_LENGTH) {
      subTables.push(tomlTable(`${header}.${tomlKey(key)}`, value));
    } else {
      lines.push(line);
    }
  }
  return [lines.join('\n'), ...subTables].join('\n\n');
}

function draftToFields(draft: Draft): Record<string, unknown> {
  const fields = { ...draft.fields };
  if (draft.args !== undefined && Object.keys(draft.args).length > 0) fields.args = draft.args;
  return fields;
}

// --- Verification ------------------------------------------------------------

/** A comparable view of a launcher's command: llama-server args are compared as a set, defaults included. */
function commandSignature(launcher: Launcher): string {
  const tokens = tokenize(launcher.commandLine);
  if (tokens !== null && tokens.length > 0 && path.basename(tokens[0] as string) === 'llama-server') {
    const parsed = parseArgTokens(tokens.slice(1));
    if (parsed !== null) {
      const args = canonicalLlamaArgs(parsed);
      args.host ??= LLAMA_SERVER_DEFAULT_HOST;
      args.port ??= String(LLAMA_SERVER_DEFAULT_PORT);
      const normalized = Object.entries(args)
        .map(([key, value]) => [key, (Array.isArray(value) ? value : [value]).map((v) => expandHome(String(v)))] as const)
        .sort(([a], [b]) => a.localeCompare(b));
      return JSON.stringify([tokens[0], normalized]);
    }
  }
  return launcher.commandLine;
}

function compareLaunchers(before: Launcher, after: Launcher): string[] {
  const problems: string[] = [];
  const check = (label: string, a: unknown, b: unknown) => {
    if (!deepEqual(a, b)) problems.push(`${before.name}: ${label} differs (${JSON.stringify(a)} → ${JSON.stringify(b)})`);
  };
  check('command', commandSignature(before), commandSignature(after));
  check('description', before.description, after.description);
  check('type', before.type, after.type);
  check('cwd', before.cwd, after.cwd);
  check('env', before.env, after.env);
  check('vram_gb', before.vramGb, after.vramGb);
  check('gpu', before.gpu, after.gpu);
  check('exclusive', before.exclusive, after.exclusive);
  check('process_match', before.processMatch, after.processMatch);
  check('stop_timeout_seconds', before.stopTimeoutSeconds, after.stopTimeoutSeconds);
  if (before.health !== undefined) check('health', before.health, after.health);
  return problems;
}

/**
 * Converts a legacy stack.json document (launchers array, one full command line
 * each) into TOML using `kind = "llama-server"`, `args`, `vars` and `extends`,
 * then reloads the result to check every launcher still behaves the same.
 */
export function migrateStackConfig(source: unknown, options: MigrateOptions = {}): MigrationResult {
  const label = options.sourceFile ?? 'stack file';
  const original = parseStackConfig(source, label);
  if (!isRecord(source) || !Array.isArray(source.launchers)) {
    throw new StackConfigError(`${label} already uses the launchers table format`);
  }

  const notes: string[] = [];
  const drafts = (source.launchers as Record<string, unknown>[]).map((conf) => draftFromLegacy(conf, notes));
  const llamas = drafts.filter((d) => d.args !== undefined);

  const vars = extractVars(llamas);
  const { roots, variants } = groupVariants(llamas);
  const bases = extractBases(roots, new Set(drafts.map((d) => d.name)));

  const sections: string[] = [];
  const header: string[] = [];
  if (options.schemaPath) header.push(`#:schema ${options.schemaPath}`);
  header.push(`# Migrated from ${label} by \`stack migrate\`.`);
  if (bases.length > 0 || variants.size > 0) {
    header.push('# A launcher with `extends` inherits everything from its parent; `args` are merged');
    header.push('# key by key and `key = false` removes an inherited flag.');
  }
  sections.push(header.join('\n'));

  const capacity = source.vram_capacity_gb ?? source.vram_capacity_in_gigabytes;
  if (capacity !== undefined) sections.push(`vram_capacity_gb = ${tomlValue(capacity)}`);
  if (Object.keys(vars).length > 0) sections.push(tomlTable('vars', vars));

  for (const base of bases) {
    sections.push(tomlTable(`launchers.${tomlKey(base.name)}`, draftToFields(base)));
  }
  for (const draft of drafts) {
    const fields = variants.get(draft.name) ?? draftToFields(draft);
    sections.push(tomlTable(`launchers.${tomlKey(draft.name)}`, fields));
  }
  const toml = `${sections.join('\n\n')}\n`;

  const migrated = parseStackConfig(Bun.TOML.parse(toml), 'migrated TOML');
  const mismatches: string[] = [];
  const byName = new Map(migrated.launchers.map((l) => [l.name, l]));
  for (const before of original.launchers) {
    const after = byName.get(before.name);
    if (after === undefined) {
      mismatches.push(`${before.name}: missing after migration`);
    } else {
      mismatches.push(...compareLaunchers(before, after));
    }
  }
  if (migrated.launchers.length !== original.launchers.length) {
    mismatches.push(`launcher count differs (${original.launchers.length} → ${migrated.launchers.length})`);
  }

  return { toml, mismatches, notes };
}
