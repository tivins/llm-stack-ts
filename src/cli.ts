#!/usr/bin/env bun
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadStackConfig, resolveStackFile } from './config';
import { ConsoleLogger } from './Logger';
import { Orchestrator } from './Orchestrator';
import { ProcessManager } from './ProcessManager';

const HELP = `Usage: stack [options] <action> [name...]
Options:
  -f, --file <path>  Stack configuration file (default: $LLM_STACK_CONFIG, ./stack.json, or script dir)
Actions:
  list               List available models (* = active)
  list-json          List available models as JSON
  start <name...>    Start one or more models, in order
                     --no-wait  Return once the process is running (skip health wait)
  stop <name...>     Stop one or more models
  status <name>      Show launcher status (inactive, starting, ready)
`;

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

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      file: { type: 'string', short: 'f' },
      'no-wait': { type: 'boolean', default: false },
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

  const logger = new ConsoleLogger();
  const processManager = new ProcessManager(path.join(tmpdir(), 'stack-llm'), logger);
  const orchestrator = new Orchestrator(processManager, config.vramCapacityGb, logger);
  for (const launcher of config.launchers) {
    orchestrator.addLauncher(launcher);
  }

  switch (action) {
    case 'list': {
      for (const launcher of orchestrator.getLaunchers()) {
        const marker = orchestrator.isLauncherActive(launcher.name) ? '*' : ' ';
        console.log(`${launcher.name} (${launcher.type}) ${marker}`);
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
          size: launcher.minimalVideoRamUsageInGigabytes,
        };
      }
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    case 'start': {
      if (names.length === 0) fail('missing model name', true);
      assertKnownLaunchers(orchestrator, names);
      for (const n of names) {
        await orchestrator.ensureActive(n, !values['no-wait']);
      }
      return;
    }

    case 'status': {
      if (!name) fail('missing model name', true);
      console.log(await orchestrator.getLauncherStatus(name));
      return;
    }

    case 'stop': {
      if (names.length === 0) fail('missing model name', true);
      assertKnownLaunchers(orchestrator, names);
      for (const n of names) {
        orchestrator.stop(n);
      }
      return;
    }

    default:
      fail(`unknown action '${action}'`, true);
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
