import path from 'node:path';
import { canonicalLlamaArgs, parseArgTokens, tokenize } from './args';
import type { ArgValue, Args } from './args';
import type { Launcher } from './Launcher';

export interface ListViewOptions {
  /** ANSI colors (active marker, headers, inherited values). */
  readonly color?: boolean;
  /** Terminal width: the last column is cut to fit. */
  readonly width?: number;
}

/** Shown in their own column, so left out of the details. */
const COLUMN_ARGS = ['model', 'ctx-size', 'reasoning-budget'];
/** Model file names can be very long; the quantization at the end is the part worth keeping. */
const MAX_MODEL_LENGTH = 36;

const ANSI = {
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
};

interface Row {
  readonly launcher: Launcher;
  readonly depth: number;
  readonly parent?: Launcher;
  /** Top of the tree: variants are grouped with it even when they change the type. */
  readonly root: Launcher;
}

/** File order, with each variant right after its parent (abstract parents are not listed). */
function treeOrder(launchers: Launcher[]): Row[] {
  const byName = new Map(launchers.map((l) => [l.name, l]));
  const children = new Map<string, Launcher[]>();
  const roots: Launcher[] = [];
  for (const launcher of launchers) {
    const parent = launcher.extends === undefined ? undefined : byName.get(launcher.extends);
    if (parent === undefined) {
      roots.push(launcher);
    } else {
      children.set(parent.name, [...(children.get(parent.name) ?? []), launcher]);
    }
  }

  const rows: Row[] = [];
  const visit = (launcher: Launcher, depth: number, root: Launcher, parent?: Launcher) => {
    rows.push({ launcher, depth, parent, root });
    for (const child of children.get(launcher.name) ?? []) visit(child, depth + 1, root, launcher);
  };
  for (const root of roots) visit(root, 0, root);
  return rows;
}

interface ArgsView {
  /** Every arg of the launcher. */
  readonly all: Args;
  /** What the launcher declares itself (all of them without `extends`). */
  readonly own: Args;
  readonly llama: boolean;
  /** `--port` of a legacy llama-server command. */
  readonly port?: string;
}

/**
 * Structured args, or for a legacy launcher whose whole `llama-server ...`
 * command sits in `command`, the args parsed back from it.
 */
function argsView(launcher: Launcher): ArgsView {
  if (Object.keys(launcher.args ?? {}).length > 0 || launcher.kind === 'llama-server') {
    return { all: launcher.args ?? {}, own: launcher.ownArgs ?? {}, llama: launcher.kind === 'llama-server' };
  }
  const tokens = tokenize(launcher.commandLine);
  const parsed = tokens !== null && path.basename(tokens[0] ?? '') === 'llama-server' ? parseArgTokens(tokens.slice(1)) : null;
  if (parsed === null) {
    return { all: {}, own: {}, llama: false };
  }
  const { host: _host, port, ...args } = canonicalLlamaArgs(parsed);
  return { all: args, own: args, llama: true, port: typeof port === 'string' ? port : undefined };
}

function modelName(args: Args | undefined): string {
  const model = args?.model;
  if (typeof model !== 'string') return '';
  const name = path.basename(model).replace(/\.gguf$/i, '');
  if (name.length <= MAX_MODEL_LENGTH) return name;
  const keep = MAX_MODEL_LENGTH - 1;
  return `${name.slice(0, Math.ceil(keep / 2))}…${name.slice(name.length - Math.floor(keep / 2))}`;
}

/** Token counts: 16384 → 16k, 262144 → 256k; unset → `-`. */
function formatTokens(value: ArgValue | undefined): string {
  const n = Number(value);
  if (value === undefined || typeof value === 'boolean' || !Number.isFinite(n)) return '-';
  return n >= 1024 && n % 1024 === 0 ? `${n / 1024}k` : String(n);
}

/** llama-server's -1 means unlimited. */
function formatReasoning(value: ArgValue | undefined): string {
  return Number(value) === -1 && typeof value !== 'boolean' ? '∞' : formatTokens(value);
}

function portOf(launcher: Launcher, view: ArgsView): string {
  if (launcher.port !== undefined) return String(launcher.port);
  if (view.port !== undefined) return view.port;
  const url = launcher.health?.url;
  if (url !== undefined && URL.canParse(url)) {
    const parsed = new URL(url);
    if (parsed.port) return parsed.port;
  }
  return '-';
}

function formatArg(key: string, value: ArgValue): string {
  if (value === true) return key;
  if (value === false) return `-${key}`;
  const short = (v: string | number) => (typeof v === 'string' && v.startsWith('/') ? path.basename(v) : String(v));
  return `${key}=${Array.isArray(value) ? value.map(short).join(',') : short(value)}`;
}

/** What sets the launcher apart: its own args, or its command for a plain command launcher. */
function details(launcher: Launcher, view: ArgsView): string {
  const parts: string[] = [];
  if (launcher.gpu && !launcher.exclusive) parts.push('shared-gpu');

  const own = Object.entries(view.own).filter(([key]) => !COLUMN_ARGS.includes(key));
  parts.push(...own.map(([key, value]) => formatArg(key, value)));

  if (!view.llama && own.length === 0) {
    const [program, ...rest] = tokenize(launcher.commandLine) ?? [launcher.commandLine];
    parts.push([path.basename(program ?? ''), ...rest].join(' '));
  }
  return parts.join(' ');
}

function truncate(value: string, max: number): string {
  if (max <= 1) return '';
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * `stack list` table: services grouped by type, variants indented under their
 * parent with only what they change, so names do not have to spell it out.
 */
export function formatLauncherList(launchers: Launcher[], isActive: (name: string) => boolean, options: ListViewOptions = {}): string {
  const style = (fn: (s: string) => string, s: string) => (options.color ? fn(s) : s);
  const rows = treeOrder(launchers);

  const views = new Map(launchers.map((l) => [l.name, argsView(l)]));
  const cells = rows.map((row) => {
    const { launcher, depth, parent } = row;
    const view = views.get(launcher.name) as ArgsView;
    const model = modelName(view.all);
    return {
      row,
      active: isActive(launcher.name),
      name: depth === 0 ? launcher.name : `${'  '.repeat(depth - 1)}└ ${launcher.name}`,
      // A variant running its parent's model leaves the column empty: the tree says it.
      model: parent !== undefined && model === modelName(views.get(parent.name)?.all) ? '' : model || '-',
      ctx: formatTokens(view.all['ctx-size']),
      reasoning: formatReasoning(view.all['reasoning-budget']),
      port: portOf(launcher, view),
      vram: launcher.gpu ? `${Number(launcher.vramGb.toFixed(2))}GB` : 'cpu',
      details: details(launcher, view),
      description: launcher.description,
    };
  });

  const header = { name: 'NAME', model: 'MODEL', ctx: 'CTX', reasoning: 'REASON', port: 'PORT', vram: 'VRAM' };
  const width = (key: keyof typeof header) => Math.max(header[key].length, ...cells.map((c) => c[key].length));
  const widths = {
    name: width('name'),
    model: width('model'),
    ctx: width('ctx'),
    reasoning: width('reasoning'),
    port: width('port'),
    vram: width('vram'),
  };
  const prefixLength = 2 + widths.name + 2 + widths.model + 2 + widths.ctx + 2 + widths.reasoning + 2 + widths.port + 2 + widths.vram + 2;

  const line = (marker: string, c: typeof header, styleName: (s: string) => string = (s) => s) =>
    `${marker} ${styleName(c.name.padEnd(widths.name))}  ${c.model.padEnd(widths.model)}  ${c.ctx.padStart(widths.ctx)}  ${c.reasoning.padStart(widths.reasoning)}  ${c.port.padEnd(widths.port)}  ${c.vram.padStart(widths.vram)}  `;

  const groups = new Map<string, typeof cells>();
  for (const cell of cells) {
    const type = cell.row.root.type || 'other';
    groups.set(type, [...(groups.get(type) ?? []), cell]);
  }

  const headerDetails = options.width === undefined ? 'DETAILS' : truncate('DETAILS', options.width - prefixLength);
  const out: string[] = [style(ANSI.dim, `${line(' ', header)}${headerDetails}`.trimEnd())];
  for (const [type, group] of groups) {
    out.push(style(ANSI.bold, type));
    for (const cell of group) {
      const marker = cell.active ? style(ANSI.green, '*') : ' ';
      const text = line(marker, cell, cell.active ? (s) => style(ANSI.green, s) : undefined);
      let detailText = cell.details;
      let descText = cell.description;
      if (options.width !== undefined) {
        const room = options.width - prefixLength;
        detailText = truncate(detailText, room);
        descText = truncate(descText, room - detailText.length - (detailText ? 2 : 0));
      }
      const tail = [detailText, descText ? style(ANSI.dim, descText) : ''].filter(Boolean).join('  ');
      out.push(`${text}${tail}`.trimEnd());
    }
  }
  return out.join('\n');
}
