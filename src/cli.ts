#!/usr/bin/env bun
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { shellQuote, tokenize } from './args';
import type { Args } from './args';
import { findMissingPaths, loadStackConfig, readStackFile, resolveStackFile } from './config';
import { formatLauncherList } from './listView';
import { migrateStackConfig } from './migrate';
import type { Orchestrator } from './Orchestrator';
import { createOrchestrator, summarizeLauncher } from './Stack';

const HELP = `Usage: stack [options] <action> [name...]
Options:
  -f, --file <path>  Stack configuration file (default: $LLM_STACK_CONFIG, ./stack.toml, ./stack.json, or script dir)
Actions:
  list               List services by type, variants under their parent (* = active)
                     -q, --quiet  Names only
  list-json          List services as JSON
  status [name...]   Show status; a single name prints inactive|starting|ready, otherwise a table
  start <name...>    Start one or more services, in order (waits for the health check)
  run <name...>      Alias of start
                     --no-wait          Return once the process is spawned
                     --arg key[=value]  Override an arg for this run (repeatable, e.g. --arg ctx-size=65536;
                                        key=false removes an inherited flag)
  restart <name...>  Stop then start one or more services (accepts --no-wait and --arg)
  show [name...]     Print the resolved command line and settings (accepts --arg)
  stop [name...]     Stop one or more services, or every active service if none is given
  logs <name>        Print the end of a service's log
                     -n, --lines <n>  Number of lines (default: 50)
                     -F, --follow     Keep printing new lines
  validate           Check the configuration file: deprecated keys, missing model files and paths
  migrate            Convert a legacy stack.json to stack.toml (extends, args, vars)
                     -o, --output <path>  Output file (default: same name with .toml, - for stdout)
                     --force              Overwrite the output file
`;

const ARG_ACTIONS = ['start', 'run', 'restart', 'show'];

const DEFAULT_LOG_LINES = 50;

function assertKnownLaunchers(orchestrator: Orchestrator, names: string[]): void {
  const known = new Set(orchestrator.getLaunchers().map((launcher) => launcher.name));
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length > 0) {
    fail(`invalid launcher: ${unknown.join(', ')}`);
  }
}

function fail(message: string, withUsage = false): never {
  process.stderr.write(`Error: ${message}\n`);
  if (withUsage) {
    process.stderr.write(HELP);
  }
  process.exit(1);
}

function formatTable(rows: string[][]): string {
  const widths = rows[0]?.map((_, col) => Math.max(...rows.map((row) => row[col]?.length ?? 0))) ?? [];
  return rows.map((row) => row.map((cell, col) => cell.padEnd(widths[col] ?? 0)).join('  ').trimEnd()).join('\n');
}

async function printStatusTable(orchestrator: Orchestrator, names: string[]): Promise<void> {
  const rows = await Promise.all(
    names.map(async (n) => {
      const launcher = orchestrator.getLauncher(n);
      const status = await orchestrator.getLauncherStatus(n);
      const pid = orchestrator.getLauncherPid(n);
      return [
        n,
        status,
        pid === null ? '-' : String(pid),
        launcher.gpu ? `${launcher.vramGb}GB` : '-',
        launcher.exclusive ? 'yes' : 'no',
        launcher.health?.url ?? '-',
      ];
    }),
  );
  console.log(formatTable([['NAME', 'STATE', 'PID', 'VRAM', 'EXCLUSIVE', 'HEALTH'], ...rows]));
}

/** `--arg ctx-size=65536` → { 'ctx-size': '65536' }; `--arg embedding` → true; `--arg x=false` → false. */
function parseArgOverrides(raw: string[]): Args {
  const args: Args = {};
  for (const item of raw) {
    const eq = item.indexOf('=');
    const key = (eq === -1 ? item : item.slice(0, eq)).trim();
    const value = eq === -1 ? 'true' : item.slice(eq + 1);
    if (key === '') fail(`--arg expects key[=value], got '${item}'`);
    args[key] = value === 'true' ? true : value === 'false' ? false : value;
  }
  return args;
}

/** One flag per line, so a long llama-server command stays readable and can be pasted back into a shell. */
function formatCommand(commandLine: string): string {
  const tokens = tokenize(commandLine);
  if (tokens === null) {
    return commandLine;
  }
  const lines: string[] = [];
  for (const token of tokens) {
    const quoted = shellQuote(token);
    if (lines.length === 0 || (token.startsWith('-') && !/^-\d/.test(token))) {
      lines.push(quoted);
    } else {
      lines[lines.length - 1] += ` ${quoted}`;
    }
  }
  return lines.join(' \\\n    ');
}

function formatLauncher(orchestrator: Orchestrator, name: string): string {
  const launcher = orchestrator.getLauncher(name);
  const vram = launcher.gpu ? `${launcher.vramGb}GB${launcher.exclusive ? ', exclusive' : ''}` : 'no (cpu)';
  const lines = [`# ${launcher.name}${launcher.type ? ` (${launcher.type})` : ''}${launcher.description ? ` - ${launcher.description}` : ''}`];
  if (launcher.cwd !== undefined) lines.push(`#   cwd:    ${launcher.cwd}`);
  for (const [key, value] of Object.entries(launcher.env ?? {})) lines.push(`#   env:    ${key}=${value}`);
  lines.push(`#   gpu:    ${vram}`, `#   health: ${launcher.health?.url ?? '-'}`, formatCommand(launcher.commandLine));
  return lines.join('\n');
}

function migrate(source: string, output: string | undefined, force: boolean): void {
  if (path.extname(source).toLowerCase() === '.toml') {
    fail(`${source} is already a TOML file`);
  }
  const target = output ?? source.replace(/(\.json)?$/i, '.toml');
  if (target !== '-' && existsSync(target) && !force) {
    fail(`${target} already exists (use --force to overwrite)`);
  }

  const result = migrateStackConfig(readStackFile(source), {
    sourceFile: source,
    schemaPath: path.resolve(import.meta.dir, '..', 'stack.schema.json'),
  });
  if (result.mismatches.length > 0) {
    fail(`migration would change these launchers, nothing written:\n${result.mismatches.map((m) => `  ${m}`).join('\n')}`);
  }
  if (target === '-') {
    process.stdout.write(result.toml);
  } else {
    writeFileSync(target, result.toml);
  }

  for (const note of result.notes) {
    process.stderr.write(`Note: ${note}\n`);
  }
  if (target === '-') {
    return;
  }

  const config = loadStackConfig(target);
  for (const launcher of config.launchers) {
    for (const missing of findMissingPaths(launcher)) {
      process.stderr.write(`Warning: ${launcher.name}: path not found: ${missing}\n`);
    }
  }
  console.log(`Wrote ${target} (${config.launchers.length} launchers, verified equivalent to ${source})`);
  if (process.env.LLM_STACK_CONFIG && path.resolve(process.env.LLM_STACK_CONFIG) === path.resolve(source)) {
    console.log(`LLM_STACK_CONFIG still points to ${source}: update it to ${path.resolve(target)} to use the new file.`);
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      file: { type: 'string', short: 'f' },
      'no-wait': { type: 'boolean', default: false },
      arg: { type: 'string', multiple: true },
      output: { type: 'string', short: 'o' },
      force: { type: 'boolean', default: false },
      quiet: { type: 'boolean', short: 'q', default: false },
      lines: { type: 'string', short: 'n' },
      follow: { type: 'boolean', short: 'F', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const [action, ...names] = positionals;
  const name = names[0];
  if (!action) {
    process.stdout.write(HELP);
    process.exitCode = 1;
    return;
  }

  const stackFile = resolveStackFile(values.file, import.meta.dir);
  if (action === 'migrate') {
    migrate(stackFile, values.output, values.force);
    return;
  }

  const overrides = values.arg === undefined ? undefined : parseArgOverrides(values.arg);
  if (overrides !== undefined && !ARG_ACTIONS.includes(action)) {
    fail(`--arg only applies to ${ARG_ACTIONS.join(', ')}`);
  }
  const config = loadStackConfig(stackFile, {
    argOverrides: overrides === undefined ? undefined : Object.fromEntries(names.map((n) => [n, overrides])),
  });

  // Deprecations only show up in `validate`, so legacy configs keep working quietly.
  for (const warning of config.warnings) {
    if (warning.level === 'warning' || action === 'validate') {
      process.stderr.write(`${warning.level === 'warning' ? 'Warning' : 'Deprecated'}: ${warning.message}\n`);
    }
  }

  const orchestrator = createOrchestrator(config);

  switch (action) {
    case 'list': {
      if (values.quiet) {
        console.log(orchestrator.getLaunchers().map((l) => l.name).join('\n'));
        return;
      }
      const tty = process.stdout.isTTY === true;
      console.log(
        formatLauncherList(orchestrator.getLaunchers(), (n) => orchestrator.isLauncherActive(n), {
          color: tty && !process.env.NO_COLOR,
          width: tty ? process.stdout.columns : undefined,
        }),
      );
      return;
    }

    case 'list-json': {
      const data: Record<string, unknown> = {};
      for (const launcher of orchestrator.getLaunchers()) {
        const { name: _name, ...summary } = summarizeLauncher(launcher);
        data[launcher.name] = { ...summary, active: orchestrator.isLauncherActive(launcher.name) };
      }
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    case 'start':
    case 'run': {
      if (names.length === 0) fail('missing service name', true);
      assertKnownLaunchers(orchestrator, names);
      for (const n of names) {
        if (overrides !== undefined && orchestrator.isLauncherActive(n)) {
          process.stderr.write(`Warning: ${n} is already running, use \`stack restart\` to apply --arg\n`);
        }
        await orchestrator.ensureActive(n, !values['no-wait']);
      }
      return;
    }

    case 'show': {
      assertKnownLaunchers(orchestrator, names);
      const shown = names.length > 0 ? names : orchestrator.getLaunchers().map((l) => l.name);
      console.log(shown.map((n) => formatLauncher(orchestrator, n)).join('\n\n'));
      return;
    }

    case 'restart': {
      if (names.length === 0) fail('missing service name', true);
      assertKnownLaunchers(orchestrator, names);
      for (const n of names) {
        orchestrator.stop(n);
        await orchestrator.ensureActive(n, !values['no-wait']);
      }
      return;
    }

    case 'status': {
      assertKnownLaunchers(orchestrator, names);
      if (names.length === 1 && name) {
        console.log(await orchestrator.getLauncherStatus(name));
        return;
      }
      await printStatusTable(orchestrator, names.length > 0 ? names : orchestrator.getLaunchers().map((l) => l.name));
      return;
    }

    case 'stop': {
      if (names.length === 0) {
        orchestrator.stopAll();
        return;
      }
      assertKnownLaunchers(orchestrator, names);
      for (const n of names) {
        orchestrator.stop(n);
      }
      return;
    }

    case 'logs': {
      if (!name) fail('missing service name', true);
      assertKnownLaunchers(orchestrator, [name]);
      const lines = values.lines === undefined ? DEFAULT_LOG_LINES : Number(values.lines);
      if (!Number.isInteger(lines) || lines < 0) fail(`--lines must be a non-negative integer`);
      const logFile = orchestrator.getLauncherLogFile(name);
      if (!logFile || !existsSync(logFile)) fail(`no log for ${name} yet${logFile ? ` (${logFile})` : ''}`);
      const tail = Bun.spawn(['tail', '-n', String(lines), ...(values.follow ? ['-F'] : []), logFile], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      process.exitCode = await tail.exited;
      return;
    }

    case 'validate': {
      let missingCount = 0;
      for (const launcher of orchestrator.getLaunchers()) {
        for (const missing of findMissingPaths(launcher)) {
          process.stderr.write(`Error: ${launcher.name}: path not found: ${missing}\n`);
          missingCount++;
        }
      }
      if (missingCount > 0) {
        fail(`${stackFile}: ${missingCount} missing path(s)`);
      }
      console.log(`OK: ${stackFile} (${config.launchers.length} launchers)`);
      return;
    }

    default:
      fail(`unknown action '${action}'`, true);
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
