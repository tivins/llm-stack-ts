import { homedir } from 'node:os';

/** An `args` value: `true` renders a bare flag, `false` omits it, an array repeats the flag. */
export type ArgValue = string | number | boolean | (string | number)[];
export type Args = Record<string, ArgValue>;

/**
 * Short spellings accepted for `kind = "llama-server"`, mapped to the long flag
 * name, so `c` and `ctx-size` never end up as two different keys after a merge.
 */
const LLAMA_SERVER_ALIASES: Record<string, string> = {
  a: 'alias',
  b: 'batch-size',
  c: 'ctx-size',
  ctk: 'cache-type-k',
  ctv: 'cache-type-v',
  dev: 'device',
  fa: 'flash-attn',
  'gpu-layers': 'n-gpu-layers',
  hf: 'hf-repo',
  hfr: 'hf-repo',
  m: 'model',
  md: 'model-draft',
  mm: 'mmproj',
  n: 'n-predict',
  ngl: 'n-gpu-layers',
  np: 'parallel',
  s: 'seed',
  sm: 'split-mode',
  t: 'threads',
  ts: 'tensor-split',
  ub: 'ubatch-size',
};

const ARG_KEY_PATTERN = /^-{0,2}[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHELL_SAFE = /^[A-Za-z0-9_\-.,/:=@%+^]+$/;

export function isArgKey(key: string): boolean {
  return ARG_KEY_PATTERN.test(key);
}

/** Long flag name for a llama-server option (`-c` / `c` → `ctx-size`). */
export function canonicalLlamaKey(key: string): string {
  const bare = key.replace(/^-+/, '');
  return LLAMA_SERVER_ALIASES[bare] ?? bare;
}

export function canonicalLlamaArgs(args: Args): Args {
  const result: Args = {};
  for (const [key, value] of Object.entries(args)) {
    result[canonicalLlamaKey(key)] = value;
  }
  return result;
}

export function shellQuote(value: string): string {
  if (SHELL_SAFE.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `~/x` → `/home/me/x`; values are quoted when rendered, so bash would not expand it. */
export function expandHome(value: string): string {
  return value === '~' || value.startsWith('~/') ? homedir() + value.slice(1) : value;
}

/** `key` → `--key`, single letters → `-k`, a key that already starts with `-` is kept as is. */
function flagName(key: string): string {
  if (key.startsWith('-')) {
    return key;
  }
  return key.length === 1 ? `-${key}` : `--${key}`;
}

function renderValue(value: string | number): string {
  return shellQuote(typeof value === 'number' ? String(value) : expandHome(value));
}

export function renderArgs(args: Args): string[] {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === false) {
      continue;
    }
    const flag = flagName(key);
    if (value === true) {
      parts.push(flag);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        parts.push(flag, renderValue(item));
      }
    } else {
      parts.push(flag, renderValue(value));
    }
  }
  return parts;
}

/**
 * Splits a command line the way bash would for simple commands (quotes and
 * backslashes, no expansion). Returns null on shell syntax it does not model
 * (pipes, redirections, variables, substitutions...).
 */
export function tokenize(command: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let i = 0;

  while (i < command.length) {
    const ch = command[i] as string;
    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      i++;
    } else if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return null;
      current += command.slice(i + 1, end);
      inToken = true;
      i = end + 1;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        if ('$`'.includes(command[j] as string)) return null;
        if (command[j] === '\\' && j + 1 < command.length) j++;
        current += command[j];
        j++;
      }
      if (j >= command.length) return null;
      inToken = true;
      i = j + 1;
    } else if (ch === '\\') {
      if (i + 1 >= command.length) return null;
      current += command[i + 1];
      inToken = true;
      i += 2;
    } else if ('|&;<>()$`*?[]{}#!'.includes(ch) || (ch === '~' && !inToken)) {
      return null;
    } else {
      current += ch;
      inToken = true;
      i++;
    }
  }
  if (inToken) {
    tokens.push(current);
  }
  return tokens;
}

/** A numeric-looking token is a value, not a flag (`--temp -1`). */
function isFlagToken(token: string): boolean {
  return token.startsWith('-') && token.length > 1 && !/^-\d/.test(token);
}

/**
 * Parses `--flag value -x --switch` tokens into an args map. Returns null when
 * a token is not a flag or a flag's value (a positional argument), since args
 * cannot express those.
 */
export function parseArgTokens(tokens: string[]): Args | null {
  const args: Args = {};
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] as string;
    if (!isFlagToken(token) || token.includes('=')) {
      return null;
    }
    const key = token.replace(/^-+/, '');
    if (key === '' || !isArgKey(key)) {
      return null;
    }
    // Keep multi-letter single-dash flags (`-fa`) recognisable as such.
    const name = !token.startsWith('--') && key.length > 1 ? token : key;
    const next = tokens[i + 1];
    let value: string | true = true;
    if (next !== undefined && !isFlagToken(next)) {
      value = next;
      i++;
    }
    i++;

    const previous = args[name];
    if (previous === undefined) {
      args[name] = value;
    } else if (value === true || previous === true) {
      return null;
    } else {
      args[name] = [...(Array.isArray(previous) ? previous : [previous as string]), value];
    }
  }
  return args;
}
