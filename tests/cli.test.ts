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

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', CLI, ...args], { stdout: 'pipe', stderr: 'pipe' });
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
});
