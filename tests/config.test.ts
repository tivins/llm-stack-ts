import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadStackConfig } from '../src/config';
import { StackConfigError } from '../src/errors';

function writeConfig(content: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'llm-stack-ts-test-'));
  const file = path.join(dir, 'stack.json');
  writeFileSync(file, JSON.stringify(content));
  return file;
}

const VALID_LAUNCHER = {
  name: 'llm_main',
  type: 'text-generation',
  description: 'Main model',
  command: 'llama-server --port 8080',
  minimal_video_ram_usage_in_gigabytes: 14,
};

describe('loadStackConfig', () => {
  test('parses a minimal valid config', () => {
    const file = writeConfig({ vram_capacity_in_gigabytes: 16, launchers: [VALID_LAUNCHER] });

    const config = loadStackConfig(file);

    expect(config.vramCapacityGb).toBe(16);
    expect(config.launchers).toHaveLength(1);
    expect(config.launchers[0]).toMatchObject({
      name: 'llm_main',
      type: 'text-generation',
      commandLine: 'llama-server --port 8080',
      minimalVideoRamUsageInGigabytes: 14,
      allowFullCPU: false,
    });
  });

  test('applies health check defaults', () => {
    const file = writeConfig({
      vram_capacity_in_gigabytes: 16,
      launchers: [{ ...VALID_LAUNCHER, health: { url: 'http://127.0.0.1:8080/health' } }],
    });

    const config = loadStackConfig(file);

    expect(config.launchers[0]?.health).toEqual({
      url: 'http://127.0.0.1:8080/health',
      timeoutSeconds: 300,
      intervalMs: 1000,
      expectedStatus: 200,
    });
  });

  test('rejects an unknown launcher type', () => {
    const file = writeConfig({
      vram_capacity_in_gigabytes: 16,
      launchers: [{ ...VALID_LAUNCHER, type: 'not-a-type' }],
    });

    expect(() => loadStackConfig(file)).toThrow(StackConfigError);
  });

  test('rejects a missing vram_capacity_in_gigabytes', () => {
    const file = writeConfig({ launchers: [VALID_LAUNCHER] });

    expect(() => loadStackConfig(file)).toThrow(StackConfigError);
  });

  test('rejects a non-existent file', () => {
    expect(() => loadStackConfig('/nonexistent/stack.json')).toThrow(StackConfigError);
  });
});
