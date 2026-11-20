#!/usr/bin/env bun
import { existsSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { shellQuote, tokenize } from './args';
import type { Args } from './args';
import { cpuOffloadWarnings, findMissingPaths, loadStackConfig, readStackFile, resolveStackFile } from './config';
import { formatLauncherList } from './listView';
import { migrateStackConfig } from './migrate';
import type { Orchestrator } from './Orchestrator';
import { defaultGpuJournalDir, formatGpuHistory, readGpuJournal } from './GpuJournal';
import { defaultGpuSamplesDir, formatGpuUsage, gpuSampleDays, readGpuSamples, runGpuSampler, summarizeGpuUsage } from './GpuUsage';
import { describeLease } from './GpuLock';
import type { JobPriority, LeaseInfo } from './GpuLock';
import { runLeaseSession } from './leaseSession';
import type { LeaseEvent } from './leaseSession';
import { ConsoleLogger } from './Logger';
import type { Logger } from './Logger';
import type { Launcher } from './Launcher';
import { createOrchestrator, describeLauncher } from './Stack';

const HELP = `Usage: stack [options] <action> [name...]
Options:
  -f, --file <path>  Stack configuration file (default: $LLM_STACK_CONFIG, ./stack.toml, ./stack.json, or script dir)
  --json             Machine-readable output on stdout (status, gpu, start, run, restart, stop, lease):
                     one JSON object, or one per line for progress events; logs go to stderr
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
                     --force            Do not wait while another client holds the GPU lease
                     --priority <0|1|2> Priority in the GPU queue (default: 1)
                     --max-wait <s>     Give up if the GPU lease is not granted within <s> seconds
                     --hold             Keep the GPU lease after the start, until Ctrl+C (priority 0 by
                                        default): other clients wait instead of stopping the service.
                                        The services stay active once the lease is released
  restart <name...>  Stop then start one or more services (accepts --no-wait, --arg, --force, --priority, --max-wait)
  show [name...]     Print the resolved command line and settings (accepts --arg)
  stop [name...]     Stop one or more services, or every active service if none is given
                     (accepts --force, --priority, --max-wait)
  lease [name]       Take the GPU lease and hold it while stdin stays open; closing stdin while still
                     waiting leaves the queue. Starts <name> under the lease first, if given.
                     Reads commands from stdin, one per line, run under the lease:
                       start <name>, restart <name>, stop <name>, touch, release
                     --holder <text>    Shown to the other clients (default: stack: lease <name>)
                     --priority <0|1|2> Priority in the GPU queue (default: 1)
                     --max-wait <s>     Give up if the lease is not granted within <s> seconds
                     With --json, events: waiting, granted, done, error, cancelled, released
  gpu                Show who holds the GPU lease and the queue, in the order clients will get it
  gpu cancel <id>    Remove a waiting client from the queue (its wait fails)
  gpu touch          Mark the GPU as in use: background (P2) jobs wait for their quiet time from now
  gpu history [days|YYYY-MM-DD]
                     Who held the GPU of this machine, per project (default: the last 7 days);
                     a date also lists each lease. --json prints the leases. Journal kept in
                     $XDG_STATE_HOME/llm-stack/gpu-journal (forge: ssh forge stack gpu history)
  gpu sample         Read the GPU (power, use, VRAM, temperature) every few seconds, until stopped;
                     meant for a service (see README). --interval <s> (default: 10).
                     Samples in $XDG_STATE_HOME/llm-stack/gpu-samples, one CSV per day
  gpu usage [days|YYYY-MM-DD]
                     Energy of the GPU per day (default: the last 14 days with samples) or per
                     hour of a date, then per project from the lease journal. --json for the data
  gpu release --force
                     Break the current lease (its holder is not told and keeps running)
  logs <name>        Print the end of a service's log
                     -n, --lines <n>  Number of lines (default: 50)
                     -F, --follow     Keep printing new lines
  validate           Check the configuration file: deprecated keys, missing model files and paths,
                     llama-server launchers with gpu = false that still use the GPU
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

/** Set by `--json`: errors are also written to stdout as `{"event":"error","message":...}`. */
let jsonOutput = false;

/** Logs to stderr, so that stdout only carries JSON with `--json`. */
class StderrLogger implements Logger {
  log(message: string): void {
    process.stderr.write(`${message}\n`);
  }
}

/**
 * One JSON line on stdout, written synchronously so that it is not lost by a `process.exit`
 * right after (an error, the end of `lease`); ignores a closed pipe (the client went away).
 */
function emitJson(value: unknown): void {
  try {
    writeSync(1, `${JSON.stringify(value)}\n`);
  } catch {
    // EPIPE: nobody is reading anymore.
  }
}

function fail(message: string, withUsage = false): never {
  if (jsonOutput) emitJson({ event: 'error', message });
  process.stderr.write(`Error: ${message}\n`);
  if (withUsage) {
    process.stderr.write(HELP);
  }
  process.exit(1);
}

const REASONS: Record<string, string> = {
  turn: 'its turn',
  priority: 'a higher priority',
  batch: 'jobs for the loaded launcher',
  idle: 'the GPU to be idle',
};

/** `[P1 comfyui] flow_editor: run 42 (pid 1234) for 3m12s`, plus the id and the reason for waiting ones. */
function describeJob(lease: LeaseInfo): string {
  const tag = `[P${lease.priority}${lease.launcher ? ` ${lease.launcher}` : ''}]`;
  const waiting = lease.acquiredAt === undefined ? `, waits for ${REASONS[lease.reason ?? 'turn']} (id ${lease.id})` : '';
  return `${tag} ${describeLease(lease)}${waiting}`;
}

function parsePriority(raw: string | undefined): JobPriority | undefined {
  if (raw === undefined) return undefined;
  if (!['0', '1', '2'].includes(raw)) fail(`--priority must be 0, 1 or 2, got '${raw}'`);
  return Number(raw) as JobPriority;
}

function parseMaxWait(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(seconds) || seconds < 0) fail(`--max-wait must be a number of seconds >= 0, got '${raw}'`);
  return seconds * 1000;
}

const HOLD_POLL_MS = 2000;

/**
 * `stack start <name...> --hold`: starts the services under one GPU lease and keeps it until
 * Ctrl+C, so other clients wait in the queue instead of stopping them. Also lets go when the
 * lease is broken (`stack gpu release --force`) or when none of the services is running anymore.
 * The services stay active once the lease is released.
 */
async function holdLease(
  orchestrator: Orchestrator,
  names: string[],
  options: { wait: boolean; priority: JobPriority; maxWait: number | undefined; overrides: boolean },
): Promise<void> {
  const stopped = new AbortController();
  const onSignal = () => stopped.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);

  const hosts = new Set(names.map((n) => orchestrator.getLauncher(n).remote?.host ?? ''));
  if (hosts.size > 1) fail('--hold: these services are not all on the same machine');
  const remote = [...hosts][0] !== '';

  let lease;
  try {
    lease = await orchestrator.acquireLease({
      holder: `stack: hold ${names.join(', ')}`,
      // A remote lease is taken on that machine, with the first service started under it.
      launcher: remote ? names[0] : undefined,
      priority: options.priority,
      maxWait: options.maxWait,
      signal: stopped.signal,
    });
  } catch (err) {
    if (!stopped.signal.aborted) throw err;
    console.log('\nInterrupted while waiting for the GPU lease');
    return;
  }
  try {
    for (const n of names) {
      if (options.overrides && orchestrator.isLauncherActive(n)) {
        process.stderr.write(`Warning: ${n} is already running, use \`stack restart\` to apply --arg\n`);
      }
      await orchestrator.ensureActive(n, { lease, wait: options.wait, signal: stopped.signal });
    }
    console.log(`Holding the GPU lease for ${names.join(', ')} (P${options.priority}). Ctrl+C to release it; the services keep running.`);
    while (!stopped.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, HOLD_POLL_MS));
      if (!lease.held) {
        process.stderr.write('GPU lease broken by another client, no longer holding it\n');
        process.exitCode = 1;
        return;
      }
      if (!names.some((n) => orchestrator.isLauncherActive(n))) {
        console.log(`${names.join(', ')} no longer running, GPU lease released`);
        return;
      }
    }
    console.log('\nGPU lease released');
  } catch (err) {
    if (!stopped.signal.aborted) throw err;
    console.log('\nInterrupted, GPU lease released');
  } finally {
    lease.release();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
  }
}

function formatTable(rows: string[][]): string {
  const widths = rows[0]?.map((_, col) => Math.max(...rows.map((row) => row[col]?.length ?? 0))) ?? [];
  return rows.map((row) => row.map((cell, col) => cell.padEnd(widths[col] ?? 0)).join('  ').trimEnd()).join('\n');
}

async function printStatusJson(orchestrator: Orchestrator, names: string[]): Promise<void> {
  const data: Record<string, unknown> = {};
  for (const n of names) {
    data[n] = { status: await orchestrator.getLauncherStatus(n), pid: orchestrator.getLauncherPid(n) };
  }
  emitJson(data);
}

/** Human form of the `stack lease` events (without --json). */
function printLeaseEvent(event: LeaseEvent): void {
  switch (event.event) {
    case 'waiting':
      return; // the orchestrator's logger already says who holds the GPU
    case 'granted':
      console.log(`GPU lease held (P${event.priority}${event.launcher ? `, ${event.launcher} ready` : ''}). Commands: start|restart|stop <name>, touch, release; Ctrl+D releases.`);
      return;
    case 'done':
      console.log(`ok: ${event.cmd}`);
      return;
    case 'error':
      process.stderr.write(`Error${event.cmd ? ` (${event.cmd})` : ''}: ${event.message}\n`);
      return;
    case 'cancelled':
      console.log(`Left the GPU queue (${event.why === 'stdin' ? 'stdin closed' : 'interrupted'})`);
      return;
    case 'released':
      console.log(`GPU lease released (${{ stdin: 'stdin closed', release: 'release', signal: 'interrupted', broken: 'broken by another client' }[event.why]})`);
      return;
  }
}

async function* stdinLines(): AsyncIterable<string> {
  for await (const line of console) yield line;
}

async function printStatusTable(orchestrator: Orchestrator, names: string[]): Promise<void> {
  const withHosts = names.some((n) => orchestrator.getLauncher(n).remote !== undefined);
  const rows = await Promise.all(
    names.map(async (n) => {
      const launcher = orchestrator.getLauncher(n);
      const status = await orchestrator.getLauncherStatus(n);
      const pid = orchestrator.getLauncherPid(n);
      const remote = orchestrator.remoteInfo(n);
      const gpu = remote ? (remote.info?.gpu ?? false) : launcher.gpu;
      const row = [
        n,
        status,
        pid === null ? '-' : String(pid),
        gpu ? `${remote ? remote.info?.size : launcher.vramGb}GB` : '-',
        (remote ? remote.info?.exclusive : launcher.exclusive) ? 'yes' : 'no',
        remote ? (remote.url ?? '-') : (launcher.health?.url ?? '-'),
      ];
      return withHosts ? [row[0] as string, remote?.host.name ?? '-', ...row.slice(1)] : row;
    }),
  );
  const header = ['NAME', 'STATE', 'PID', 'VRAM', 'EXCLUSIVE', 'HEALTH'];
  console.log(formatTable([withHosts ? ['NAME', 'HOST', ...header.slice(1, 5), 'HEALTH / URL'] : header, ...rows]));
}

/** For `stack list`: a remote launcher shown with what its machine says (model, context, VRAM, local port). */
function displayLauncher(orchestrator: Orchestrator, launcher: Launcher): Launcher {
  const remote = orchestrator.remoteInfo(launcher.name);
  if (remote === null) return launcher;
  const info = remote.info;
  const args: Args = {};
  if (info?.model !== undefined) args.model = info.model;
  if (info?.ctxSize !== undefined) args['ctx-size'] = info.ctxSize;
  if (info?.reasoningBudget !== undefined) args['reasoning-budget'] = info.reasoningBudget;
  return {
    ...launcher,
    type: launcher.type || info?.type || '',
    description: launcher.description || info?.description || '',
    args,
    ownArgs: args,
    port: remote.port,
    vramGb: info?.size ?? 0,
    gpu: info?.gpu ?? false,
    exclusive: info?.exclusive ?? false,
  };
}

/** Runs `stack <args>` on the remote machine of a launcher, output straight to this terminal. */
async function passThrough(orchestrator: Orchestrator, name: string, args: string[]): Promise<number> {
  const remote = orchestrator.remoteInfo(name);
  if (remote === null) return 1;
  const proc = Bun.spawn(remote.host.argv(args), { stdio: ['ignore', 'inherit', 'inherit'] });
  return proc.exited;
}

/** `stack gpu history [days|YYYY-MM-DD]`: the last 7 days by default; a date is that local day. */
function historyRange(arg: string | undefined): { since: number; until: number; title: string; detail: boolean } {
  const day = arg?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (day) {
    const since = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime();
    const until = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]) + 1).getTime();
    return { since, until, title: arg!, detail: true };
  }
  const days = arg === undefined ? 7 : Number(arg);
  if (!Number.isInteger(days) || days < 1) fail(`gpu history expects a number of days or a date (YYYY-MM-DD), got '${arg}'`, true);
  return { since: Date.now() - days * 24 * 3600_000, until: Infinity, title: `Last ${days} days`, detail: false };
}

function printGpuStatus(label: string, status: { holder: LeaseInfo | null; waiting: LeaseInfo[] } | null): void {
  console.log(status?.holder ? `${label}held by ${describeJob(status.holder)}` : `${label}free`);
  if (status && status.waiting.length > 0) {
    console.log(`Waiting:\n${status.waiting.map((lease) => `  ${describeJob(lease)}`).join('\n')}`);
  }
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
      hold: { type: 'boolean', default: false },
      priority: { type: 'string' },
      'max-wait': { type: 'string' },
      interval: { type: 'string' },
      holder: { type: 'string' },
      json: { type: 'boolean', default: false },
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

  jsonOutput = values.json;
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

  const orchestrator = createOrchestrator(config, { holder: 'stack', logger: values.json ? new StderrLogger() : new ConsoleLogger() });
  if (values.holder !== undefined && action !== 'lease') {
    fail('--holder only applies to lease');
  }
  if (values.hold && action !== 'start' && action !== 'run') {
    fail('--hold only applies to start and run');
  }
  const force = values.force;
  const priority = parsePriority(values.priority);
  const maxWait = parseMaxWait(values['max-wait']);
  // With --json, start/restart/stop report their wait for the GPU and their end as JSON lines.
  const onWait = values.json
    ? (holder: LeaseInfo | null, me: { position: number; reason: string }) => emitJson({ event: 'waiting', holder, position: me.position, reason: me.reason })
    : undefined;
  const done = (cmd: string) => {
    if (values.json) emitJson({ event: 'done', cmd });
  };

  switch (action) {
    case 'list': {
      if (values.quiet) {
        console.log(orchestrator.getLaunchers().map((l) => l.name).join('\n'));
        return;
      }
      for (const warning of cpuOffloadWarnings(orchestrator.getLaunchers())) {
        process.stderr.write(`Warning: ${warning.message}\n`);
      }
      const tty = process.stdout.isTTY === true;
      console.log(
        formatLauncherList(orchestrator.getLaunchers().map((l) => displayLauncher(orchestrator, l)), (n) => orchestrator.isLauncherActive(n), {
          color: tty && !process.env.NO_COLOR,
          width: tty ? process.stdout.columns : undefined,
        }),
      );
      return;
    }

    case 'list-json': {
      const data: Record<string, unknown> = {};
      for (const launcher of orchestrator.getLaunchers()) {
        const { name: _name, ...summary } = describeLauncher(orchestrator, launcher);
        data[launcher.name] = summary;
      }
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    case 'start':
    case 'run': {
      if (names.length === 0) fail('missing service name', true);
      assertKnownLaunchers(orchestrator, names);
      if (values.hold) {
        if (force) fail('--hold takes the GPU lease, --force skips it: use one or the other');
        await holdLease(orchestrator, names, { wait: !values['no-wait'], priority: priority ?? 0, maxWait, overrides: overrides !== undefined });
        return;
      }
      for (const n of names) {
        if (overrides !== undefined && orchestrator.isLauncherActive(n)) {
          process.stderr.write(`Warning: ${n} is already running, use \`stack restart\` to apply --arg\n`);
        }
        await orchestrator.ensureActive(n, { wait: !values['no-wait'], force, priority, maxWait, onWait });
        done(`start ${n}`);
      }
      return;
    }

    case 'show': {
      assertKnownLaunchers(orchestrator, names);
      const shown = names.length > 0 ? names : orchestrator.getLaunchers().map((l) => l.name);
      for (const [i, n] of shown.entries()) {
        const remote = orchestrator.getLauncher(n).remote;
        if (i > 0) console.log('');
        if (remote === undefined) {
          console.log(formatLauncher(orchestrator, n));
          continue;
        }
        console.log(`# ${n} runs on ${remote.host}${remote.name === n ? '' : ` as ${remote.name}`}; there:`);
        await passThrough(orchestrator, n, ['show', remote.name]);
      }
      return;
    }

    case 'restart': {
      if (names.length === 0) fail('missing service name', true);
      assertKnownLaunchers(orchestrator, names);
      for (const n of names) {
        await orchestrator.restart(n, { wait: !values['no-wait'], force, priority, maxWait, onWait });
        done(`restart ${n}`);
      }
      return;
    }

    case 'status': {
      assertKnownLaunchers(orchestrator, names);
      if (values.json) {
        await printStatusJson(orchestrator, names.length > 0 ? names : orchestrator.getLaunchers().map((l) => l.name));
        return;
      }
      if (names.length === 1 && name) {
        console.log(await orchestrator.getLauncherStatus(name));
        return;
      }
      await printStatusTable(orchestrator, names.length > 0 ? names : orchestrator.getLaunchers().map((l) => l.name));
      return;
    }

    case 'stop': {
      if (names.length === 0) {
        await orchestrator.stopAll({ force, priority, maxWait, onWait });
        done('stop');
        return;
      }
      assertKnownLaunchers(orchestrator, names);
      for (const n of names) {
        await orchestrator.stop(n, { force, priority, maxWait, onWait });
        done(`stop ${n}`);
      }
      return;
    }

    case 'gpu': {
      if (name === 'release') {
        if (!force) fail('`stack gpu release` breaks the lease of a client that may still be using the GPU: add --force');
        const broken = orchestrator.breakLease();
        console.log(broken === null ? 'GPU: free, nothing to release' : `Released the lease of ${describeLease(broken)}`);
        return;
      }
      if (name === 'touch') {
        orchestrator.touchGpu();
        return;
      }
      if (name === 'cancel') {
        const id = names[1];
        if (id === undefined) fail('missing id (shown by `stack gpu`)', true);
        const cancelled = orchestrator.cancelLeaseRequest(id);
        if (cancelled === null) fail(`no waiting client with id ${id}`);
        console.log(`Cancelled ${describeJob(cancelled)}`);
        return;
      }
      if (name === 'history') {
        const range = historyRange(names[1]);
        const entries = readGpuJournal(defaultGpuJournalDir(), range.since, range.until);
        if (values.json) emitJson(entries);
        else console.log(formatGpuHistory(entries, range.title, range.detail));
        return;
      }
      if (name === 'sample') {
        const seconds = values.interval === undefined ? 10 : Number(values.interval);
        if (!(seconds >= 1)) fail('--interval must be a number of seconds >= 1');
        const stop = new AbortController();
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => stop.abort());
        await runGpuSampler(defaultGpuSamplesDir(), seconds * 1000, stop.signal);
        return;
      }
      if (name === 'usage') {
        const dir = defaultGpuSamplesDir();
        const arg = names[1];
        const date = arg !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(arg);
        const count = arg === undefined ? 14 : Number(arg);
        if (!date && !(Number.isInteger(count) && count >= 1)) fail(`gpu usage expects a number of days or a date (YYYY-MM-DD), got '${arg}'`, true);
        const days = date ? [arg!] : gpuSampleDays(dir).slice(-count);
        const samples = readGpuSamples(dir, days);
        const leases = samples.length === 0 ? [] : readGpuJournal(defaultGpuJournalDir(), samples[0]!.at, samples.at(-1)!.at + 1);
        const usage = summarizeGpuUsage(samples, leases, date ? 'hour' : 'day');
        if (values.json) emitJson(usage);
        else console.log(formatGpuUsage(usage, date ? 'hour' : 'day'));
        return;
      }
      if (name !== undefined) fail(`unknown gpu action '${name}'`, true);
      const status = orchestrator.leaseStatus();
      // JSON stays the local queue only: it is what a remote client of this machine reads.
      if (values.json) {
        emitJson(status ?? { holder: null, waiting: [] });
        return;
      }
      printGpuStatus('GPU: ', status);
      const remotes = await orchestrator.remoteLeaseStatus();
      for (const [host, remoteStatus] of Object.entries(remotes)) {
        if (remoteStatus === null) console.log(`GPU of ${host}: unreachable`);
        else printGpuStatus(`GPU of ${host}: `, remoteStatus);
      }
      return;
    }

    case 'lease': {
      if (names.length > 1) fail('lease takes at most one service name', true);
      if (force) fail('lease takes the GPU lease, --force skips it');
      if (name !== undefined) assertKnownLaunchers(orchestrator, [name]);
      const interrupted = new AbortController();
      const onSignal = () => interrupted.abort();
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      process.on('SIGHUP', onSignal);
      try {
        const why = await runLeaseSession(
          orchestrator,
          { holder: values.holder ?? `stack: lease${name ? ` ${name}` : ''}`, priority, launcher: name, maxWait, signal: interrupted.signal },
          stdinLines(),
          values.json ? emitJson : printLeaseEvent,
        );
        if (why === 'broken') process.exitCode = 1;
      } finally {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        process.off('SIGHUP', onSignal);
      }
      // stdin may still be open (release command, signal): do not wait for it.
      process.exit(process.exitCode ?? 0);
    }

    case 'logs': {
      if (!name) fail('missing service name', true);
      assertKnownLaunchers(orchestrator, [name]);
      const lines = values.lines === undefined ? DEFAULT_LOG_LINES : Number(values.lines);
      if (!Number.isInteger(lines) || lines < 0) fail(`--lines must be a non-negative integer`);
      const remoteLogs = orchestrator.getLauncher(name).remote;
      if (remoteLogs !== undefined) {
        process.exitCode = await passThrough(orchestrator, name, ['logs', remoteLogs.name, '-n', String(lines), ...(values.follow ? ['-F'] : [])]);
        return;
      }
      const logFile = orchestrator.getLauncherLogFile(name);
      if (!logFile || !existsSync(logFile)) fail(`no log for ${name} yet${logFile ? ` (${logFile})` : ''}`);
      const tail = Bun.spawn(['tail', '-n', String(lines), ...(values.follow ? ['-F'] : []), logFile], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      process.exitCode = await tail.exited;
      return;
    }

    case 'validate': {
      for (const warning of cpuOffloadWarnings(orchestrator.getLaunchers())) {
        process.stderr.write(`Warning: ${warning.message}\n`);
      }
      let missingCount = 0;
      for (const launcher of orchestrator.getLaunchers()) {
        for (const missing of findMissingPaths(launcher)) {
          process.stderr.write(`Error: ${launcher.name}: path not found: ${missing}\n`);
          missingCount++;
        }
      }
      for (const host of orchestrator.getRemotes()) {
        const remoteLaunchers = await host.launchers();
        const ours = orchestrator.getLaunchers().filter((l) => l.remote?.host === host.name);
        if (remoteLaunchers === null) {
          process.stderr.write(`Warning: ${host.name} cannot be reached, its ${ours.length} launcher(s) not checked\n`);
          continue;
        }
        for (const launcher of ours) {
          if (launcher.remote && !(launcher.remote.name in remoteLaunchers)) {
            process.stderr.write(`Error: ${launcher.name}: ${host.name} has no launcher '${launcher.remote.name}'\n`);
            missingCount++;
          }
        }
      }
      if (missingCount > 0) {
        fail(`${stackFile}: ${missingCount} missing path(s) or remote launcher(s)`);
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
