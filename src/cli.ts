#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadStackConfig, resolveStackFile } from './config';
import type { Orchestrator } from './Orchestrator';
import { createOrchestrator } from './Stack';

const HELP = `Usage: stack [options] <action> [name...]
Options:
  -f, --file <path>  Stack configuration file (default: $LLM_STACK_CONFIG, ./stack.json, or script dir)
Actions:
  list               List services (* = active)
  list-json          List services as JSON
  status [name...]   Show status; a single name prints inactive|starting|ready, otherwise a table
  start <name...>    Start one or more services, in order (waits for the health check)
  run <name...>      Alias of start
                     --no-wait  Return once the process is spawned
  restart <name...>  Stop then start one or more services (accepts --no-wait)
  stop [name...]     Stop one or more services, or every active service if none is given
  logs <name>        Print the end of a service's log
                     -n, --lines <n>  Number of lines (default: 50)
                     -F, --follow     Keep printing new lines
  validate           Check the configuration file, including deprecated keys
`;

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

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      file: { type: 'string', short: 'f' },
      'no-wait': { type: 'boolean', default: false },
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
  const config = loadStackConfig(stackFile);

  // Deprecations only show up in `validate`, so legacy configs keep working quietly.
  for (const warning of config.warnings) {
    if (warning.level === 'warning' || action === 'validate') {
      process.stderr.write(`${warning.level === 'warning' ? 'Warning' : 'Deprecated'}: ${warning.message}\n`);
    }
  }

  const orchestrator = createOrchestrator(config);

  switch (action) {
    case 'list': {
      for (const launcher of orchestrator.getLaunchers()) {
        const marker = orchestrator.isLauncherActive(launcher.name) ? '*' : ' ';
        const type = launcher.type ? ` (${launcher.type})` : '';
        console.log(`${launcher.name}${type} ${marker}`);
      }
      return;
    }

    case 'list-json': {
      const data: Record<string, unknown> = {};
      for (const launcher of orchestrator.getLaunchers()) {
        data[launcher.name] = {
          type: launcher.type,
          description: launcher.description,
          active: orchestrator.isLauncherActive(launcher.name),
          size: launcher.vramGb,
          gpu: launcher.gpu,
          exclusive: launcher.exclusive,
        };
      }
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    case 'start':
    case 'run': {
      if (names.length === 0) fail('missing service name', true);
      assertKnownLaunchers(orchestrator, names);
      for (const n of names) {
        await orchestrator.ensureActive(n, !values['no-wait']);
      }
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
      for (const launcher of orchestrator.getLaunchers()) {
        if (launcher.cwd !== undefined && !existsSync(launcher.cwd)) {
          process.stderr.write(`Warning: ${launcher.name} cwd not found: ${launcher.cwd}\n`);
        }
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
