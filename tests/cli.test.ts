import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLI = path.join(import.meta.dir, '../src/cli.ts');

function writeConfig(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'llm-stack-ts-cli-'));
  const file = path.join(dir, 'stack.json');
  writeFileSync(
    file,
    JSON.stringify({
      vram_capacity_in_gigabytes: 16,
      launchers: [
        {
          name: 'llm_main',
          type: 'text-generation',
          description: 'Main model',
          command: 'true',
          minimal_video_ram_usage_in_gigabytes: 1,
        },
      ],
    }),
  );
  return file;
}

async function runCli(args: string[], env?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', CLI, ...args], { stdout: 'pipe', stderr: 'pipe', env: env && { ...process.env, ...env } });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe('cli', () => {
  test('run rejects an unknown launcher the same way as start', async () => {
    const file = writeConfig();

    const viaRun = await runCli(['-f', file, 'run', 'missing']);
    const viaStart = await runCli(['-f', file, 'start', 'missing']);

    expect(viaRun.code).toBe(1);
    expect(viaRun.stderr).toBe(viaStart.stderr);
    expect(viaRun.stderr).toContain('invalid launcher: missing');
  });

  test('run without a model name fails like start', async () => {
    const file = writeConfig();

    const viaRun = await runCli(['-f', file, 'run']);
    const viaStart = await runCli(['-f', file, 'start']);

    expect(viaRun.code).toBe(1);
    expect(viaRun.stderr).toBe(viaStart.stderr);
    expect(viaRun.stderr).toContain('missing service name');
  });

  test('show prints the resolved command, with --arg overrides', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'llm-stack-ts-cli-'));
    const file = path.join(dir, 'stack.toml');
    writeFileSync(file, '[launchers.llm]\nkind = "llama-server"\nargs = { m = "/m.gguf", c = 4096 }\n');

    const result = await runCli(['-f', file, 'show', 'llm', '--arg', 'ctx-size=8192', '--arg', 'embedding']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('#   health: http://127.0.0.1:8080/health');
    expect(result.stdout).toContain('llama-server \\\n    --model /m.gguf \\\n    --ctx-size 8192 \\\n    --embedding');
  });

  test('--arg is refused for actions that do not start anything', async () => {
    const result = await runCli(['-f', writeConfig(), 'list', '--arg', 'c=1']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--arg only applies to');
  });

  test('migrate writes a TOML file next to the JSON one and refuses to overwrite it', async () => {
    const file = writeConfig();
    const target = file.replace(/\.json$/, '.toml');

    const first = await runCli(['-f', file, 'migrate']);
    const second = await runCli(['-f', file, 'migrate']);

    expect(first.code).toBe(0);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf-8')).toContain('[launchers.llm_main]');
    expect(second.code).toBe(1);
    expect(second.stderr).toContain('already exists');
  });

  test('validate fails on a missing model file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'llm-stack-ts-cli-'));
    const file = path.join(dir, 'stack.toml');
    writeFileSync(file, '[launchers.llm]\nkind = "llama-server"\nargs = { model = "/nonexistent/m.gguf" }\n');

    const result = await runCli(['-f', file, 'validate']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('llm: path not found: /nonexistent/m.gguf');
  });

  test('gpu release refuses to break the lease without --force', async () => {
    const file = writeConfig();

    const result = await runCli(['-f', file, 'gpu', 'release']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('add --force');
  });

  test('--hold is refused with --force and outside start/run', async () => {
    const file = writeConfig();

    const withForce = await runCli(['-f', file, 'start', 'llm_main', '--hold', '--force']);
    const withStop = await runCli(['-f', file, 'stop', 'llm_main', '--hold']);

    expect(withForce.code).toBe(1);
    expect(withForce.stderr).toContain('use one or the other');
    expect(withStop.code).toBe(1);
    expect(withStop.stderr).toContain('--hold only applies to start and run');
  });

  test('start --hold keeps the GPU lease until SIGINT and leaves the service running', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'llm-stack-ts-cli-'));
    const file = path.join(dir, 'stack.toml');
    writeFileSync(file, 'vram_capacity_gb = 16\n[launchers.svc]\ncommand = "sleep 60"\nvram_gb = 1\n');
    // os.tmpdir() follows TMPDIR: PID files and the GPU lease stay inside this test.
    const env = { TMPDIR: dir, XDG_STATE_HOME: dir };

    const hold = Bun.spawn(['bun', CLI, '-f', file, 'start', 'svc', '--hold'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...env },
    });
    const reader = hold.stdout.getReader();
    let out = '';
    while (!out.includes('Holding the GPU lease')) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    expect(out).toContain('Holding the GPU lease for svc (P0)');

    const during = await runCli(['-f', file, 'gpu'], env);
    expect(during.stdout).toContain('GPU: held by [P0] stack: hold svc');

    hold.kill('SIGINT');
    expect(await hold.exited).toBe(0);

    const after = await runCli(['-f', file, 'gpu'], env);
    const status = await runCli(['-f', file, 'status', 'svc'], env);
    await runCli(['-f', file, 'stop', 'svc'], env);
    expect(after.stdout).toContain('GPU: free');
    expect(status.stdout.trim()).toBe('ready');
  }, 20000);

  test('lease --json holds the lease while stdin is open and runs its commands', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'llm-stack-ts-cli-'));
    const file = path.join(dir, 'stack.toml');
    writeFileSync(file, '[launchers.svc]\ncommand = "sleep 30"\nvram_gb = 1\n');
    const env = { TMPDIR: dir, XDG_STATE_HOME: dir };

    const proc = Bun.spawn(['bun', CLI, '-f', file, 'lease', '--json', '--holder', 'pc: test', '--priority', '0'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...env },
    });
    const lines = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    const nextEvent = async (): Promise<Record<string, unknown>> => {
      while (!buffer.includes('\n')) {
        const { value, done } = await lines.read();
        if (done) throw new Error(`stdout closed, got: ${buffer}`);
        buffer += value;
      }
      const at = buffer.indexOf('\n');
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      return JSON.parse(line);
    };

    expect(await nextEvent()).toMatchObject({ event: 'granted', priority: 0 });
    const gpu = JSON.parse((await runCli(['-f', file, 'gpu', '--json'], env)).stdout);
    expect(gpu.holder).toMatchObject({ holder: 'pc: test', priority: 0, pid: proc.pid });

    proc.stdin.write('start svc\n');
    proc.stdin.flush();
    expect(await nextEvent()).toEqual({ event: 'done', cmd: 'start svc' });
    const status = JSON.parse((await runCli(['-f', file, 'status', '--json'], env)).stdout);
    expect(status.svc.status).toBe('ready');

    proc.stdin.end();
    expect(await nextEvent()).toEqual({ event: 'released', why: 'stdin' });
    expect(await proc.exited).toBe(0);
    expect(JSON.parse((await runCli(['-f', file, 'gpu', '--json'], env)).stdout)).toEqual({ holder: null, waiting: [] });
    await runCli(['-f', file, 'stop', 'svc'], env);
  }, 20000);

  test('--json errors are written to stdout too', async () => {
    const result = await runCli(['-f', writeConfig(), 'status', 'missing', '--json']);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ event: 'error', message: 'invalid launcher: missing' });
  });
});
