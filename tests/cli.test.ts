import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
    expect(viaRun.stderr).toContain('missing model name');
  });
});
