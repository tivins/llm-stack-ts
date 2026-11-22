import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Stack } from '../src/Stack';

const started: Stack[] = [];
afterEach(async () => {
  for (const stack of started.splice(0)) {
    await stack.stopAll({ force: true });
  }
});

/** Writes the stack file with these launchers (all exclusive GPU `sleep`s), a little later each time. */
function writeConfig(file: string, names: string[], bumpSeconds: number): void {
  writeFileSync(file, names.map((name, i) => `[launchers.${name}]\ncommand = "sleep 4${i}"\nvram_gb = 1\n`).join('\n'));
  const when = new Date(Date.now() + bumpSeconds * 1000);
  utimesSync(file, when, when);
}

function setup(names: string[]): { file: string; open: () => Stack } {
  const dir = mkdtempSync(path.join(tmpdir(), 'llm-stack-ts-reload-'));
  const file = path.join(dir, 'stack.toml');
  writeConfig(file, names, 0);
  const open = () => {
    const stack = new Stack({ file, pidDir: path.join(dir, 'pids'), logDir: path.join(dir, 'logs'), gpuJournalDir: path.join(dir, 'journal') });
    started.push(stack);
    return stack;
  };
  return { file, open };
}

describe('Stack: stack file edited while it runs', () => {
  test('a launcher added to the file is seen, and stopped by an exclusive start', async () => {
    const { file, open } = setup(['comfy']);
    const longRunning = open();
    writeConfig(file, ['comfy', 'qwen'], 5);

    const other = open();
    await other.start('qwen');
    expect(other.isActive('qwen')).toBe(true);

    expect(longRunning.list().map((l) => l.name).sort()).toEqual(['comfy', 'qwen']);
    await longRunning.start('comfy');
    expect(longRunning.isActive('comfy')).toBe(true);
    expect(other.isActive('qwen')).toBe(false);
  });

  test('a running launcher removed from the file is still stopped by an exclusive start', async () => {
    const { file, open } = setup(['comfy', 'old']);
    const stack = open();
    await stack.start('old');
    writeConfig(file, ['comfy'], 5);

    expect(stack.list().map((l) => l.name).sort()).toEqual(['comfy', 'old']);
    await stack.start('comfy');
    expect(stack.isActive('old')).toBe(false);
    // Stopped: dropped at the next reload.
    writeConfig(file, ['comfy'], 10);
    expect(stack.list().map((l) => l.name)).toEqual(['comfy']);
  });

  test('a file that no longer parses keeps the previous launchers', async () => {
    const { file, open } = setup(['comfy']);
    const stack = open();
    writeFileSync(file, '[launchers.broken\n');
    const when = new Date(Date.now() + 5000);
    utimesSync(file, when, when);
    expect(stack.list().map((l) => l.name)).toEqual(['comfy']);
  });
});
