import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { findMissingPaths, loadStackConfig } from '../src/config';
import type { Launcher } from '../src/Launcher';
import { StackConfigError } from '../src/errors';

function writeConfig(content: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'llm-stack-ts-test-'));
  const file = path.join(dir, 'stack.json');
  writeFileSync(file, JSON.stringify(content));
  return file;
}

const VALID_LAUNCHER = {
  name: 'llm_main',
  command: 'llama-server --port 8080',
  vram_gb: 14,
};

describe('loadStackConfig', () => {
  test('parses a minimal valid config with defaults', () => {
    const file = writeConfig({ vram_capacity_gb: 16, launchers: [VALID_LAUNCHER] });

    const config = loadStackConfig(file);

    expect(config.vramCapacityGb).toBe(16);
    expect(config.warnings).toEqual([]);
    expect(config.launchers).toHaveLength(1);
    expect(config.launchers[0]).toMatchObject({
      name: 'llm_main',
      type: '',
      description: '',
      commandLine: 'llama-server --port 8080',
      vramGb: 14,
      gpu: true,
      exclusive: true,
      stopTimeoutSeconds: 10,
    });
  });

  test('vram capacity and per-launcher vram are optional', () => {
    const file = writeConfig({ launchers: [{ name: 'a', command: 'true' }] });

    const config = loadStackConfig(file);

    expect(config.vramCapacityGb).toBeUndefined();
    expect(config.launchers[0]?.vramGb).toBe(0);
  });

  test('exclusive defaults to the gpu flag', () => {
    const file = writeConfig({
      launchers: [
        { name: 'cpu', command: 'true', gpu: false },
        { name: 'shared', command: 'true', gpu: true, exclusive: false },
      ],
    });

    const [cpu, shared] = loadStackConfig(file).launchers;

    expect(cpu).toMatchObject({ gpu: false, exclusive: false });
    expect(shared).toMatchObject({ gpu: true, exclusive: false });
  });

  test('parses cwd (with ~ expansion) and env', () => {
    const file = writeConfig({
      launchers: [{ name: 'comfyui', command: 'python main.py', cwd: '~/comfyui', env: { CUDA_VISIBLE_DEVICES: '0' } }],
    });

    const launcher = loadStackConfig(file).launchers[0];

    expect(launcher?.cwd).toBe(path.join(homedir(), 'comfyui'));
    expect(launcher?.env).toEqual({ CUDA_VISIBLE_DEVICES: '0' });
  });

  test('maps legacy keys and reports them as deprecations', () => {
    const file = writeConfig({
      vram_capacity_in_gigabytes: 16,
      launchers: [
        { ...VALID_LAUNCHER, vram_gb: undefined, minimal_video_ram_usage_in_gigabytes: 14, allow_full_cpu: false },
        { name: 'embed', command: 'true', minimal_video_ram_usage_in_gigabytes: 0.6, allow_full_cpu: true },
      ],
    });

    const config = loadStackConfig(file);

    expect(config.vramCapacityGb).toBe(16);
    expect(config.launchers[0]).toMatchObject({ vramGb: 14, gpu: true, exclusive: true });
    expect(config.launchers[1]).toMatchObject({ vramGb: 0.6, gpu: false, exclusive: false });
    expect(config.warnings.every((w) => w.level === 'deprecation')).toBe(true);
    expect(config.warnings.map((w) => w.message)).toContain('stack file vram_capacity_in_gigabytes is deprecated, use vram_capacity_gb');
  });

  test('rejects allow_full_cpu combined with gpu or exclusive', () => {
    const file = writeConfig({ launchers: [{ ...VALID_LAUNCHER, allow_full_cpu: true, gpu: false }] });

    expect(() => loadStackConfig(file)).toThrow(/cannot combine allow_full_cpu/);
  });

  test('rejects a key given under both its current and legacy name', () => {
    const file = writeConfig({ launchers: [{ ...VALID_LAUNCHER, minimal_video_ram_usage_in_gigabytes: 14 }] });

    expect(() => loadStackConfig(file)).toThrow(/cannot set both vram_gb and minimal_video_ram_usage_in_gigabytes/);
  });

  test('accepts any type label', () => {
    const file = writeConfig({ launchers: [{ ...VALID_LAUNCHER, type: 'image-workflow' }] });

    expect(loadStackConfig(file).launchers[0]?.type).toBe('image-workflow');
  });

  test('warns about unknown keys instead of failing', () => {
    const file = writeConfig({
      $schema: './stack.schema.json',
      launchers: [{ ...VALID_LAUNCHER, healt: {}, health: { url: 'http://127.0.0.1:8080/health', timeout_second: 5 } }],
    });

    const config = loadStackConfig(file);

    expect(config.warnings).toEqual([
      { level: 'warning', message: "launchers[0] (llm_main) has unknown key 'healt' (ignored)" },
      { level: 'warning', message: "launchers[0] (llm_main) health has unknown key 'timeout_second' (ignored)" },
    ]);
  });

  test('applies health check defaults', () => {
    const file = writeConfig({
      launchers: [{ ...VALID_LAUNCHER, health: { url: 'http://127.0.0.1:8080/health' } }],
    });

    const config = loadStackConfig(file);

    expect(config.launchers[0]?.health).toEqual({
      url: 'http://127.0.0.1:8080/health',
      timeoutSeconds: 300,
      intervalMs: 1000,
      expectedStatus: undefined,
    });
  });

  test('rejects an invalid health url', () => {
    const file = writeConfig({ launchers: [{ ...VALID_LAUNCHER, health: { url: '127.0.0.1:8080' } }] });

    expect(() => loadStackConfig(file)).toThrow(/not a valid URL/);
  });

  test('rejects duplicate launcher names', () => {
    const file = writeConfig({ launchers: [VALID_LAUNCHER, VALID_LAUNCHER] });

    expect(() => loadStackConfig(file)).toThrow(/duplicates the name 'llm_main'/);
  });

  test('rejects a name that cannot be used as a file name', () => {
    const file = writeConfig({ launchers: [{ ...VALID_LAUNCHER, name: '../evil' }] });

    expect(() => loadStackConfig(file)).toThrow(StackConfigError);
  });

  test('rejects a missing command', () => {
    const file = writeConfig({ launchers: [{ name: 'a' }] });

    expect(() => loadStackConfig(file)).toThrow(/requires a command/);
  });

  test('rejects a non-existent file', () => {
    expect(() => loadStackConfig('/nonexistent/stack.json')).toThrow(StackConfigError);
  });
});

function writeToml(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'llm-stack-ts-test-'));
  const file = path.join(dir, 'stack.toml');
  writeFileSync(file, content);
  return file;
}

describe('loadStackConfig (TOML, extends, args)', () => {
  const BASE = `
[vars]
models = "/models"

[launchers._llama]
abstract = true
kind = "llama-server"
command = "/bin/llama-server"
vram_gb = 14
health = { timeout_seconds = 60 }
args = { flash-attn = "on", parallel = 1 }

[launchers.gemma]
extends = "_llama"
type = "text-generation"
args = { m = "\${models}/gemma.gguf", c = 16384, reasoning-budget = 4096 }
`;

  test('reads launchers keyed by name and skips abstract ones', () => {
    const config = loadStackConfig(writeToml(BASE));

    expect(config.warnings).toEqual([]);
    expect(config.launchers.map((l) => l.name)).toEqual(['gemma']);
  });

  test('llama-server kind renders args, host/port and derives the health url', () => {
    const [gemma] = loadStackConfig(writeToml(BASE)).launchers;

    expect(gemma?.commandLine).toBe(
      '/bin/llama-server --flash-attn on --parallel 1 --model /models/gemma.gguf --ctx-size 16384 --reasoning-budget 4096 --host 127.0.0.1 --port 8080',
    );
    expect(gemma?.health).toEqual({ url: 'http://127.0.0.1:8080/health', timeoutSeconds: 60, intervalMs: 1000, expectedStatus: undefined });
    expect(gemma).toMatchObject({ vramGb: 14, type: 'text-generation', gpu: true, exclusive: true });
  });

  test('a variant merges args key by key, short and long spellings included, and false removes a flag', () => {
    const file = writeToml(`${BASE}
[launchers.gemma_long]
extends = "gemma"
port = 8090
args = { ctx-size = 65536, reasoning-budget = false, fa = "off" }
`);
    const long = loadStackConfig(file).launchers.find((l) => l.name === 'gemma_long');

    expect(long?.commandLine).toBe(
      '/bin/llama-server --flash-attn off --parallel 1 --model /models/gemma.gguf --ctx-size 65536 --host 127.0.0.1 --port 8090',
    );
    expect(long?.health?.url).toBe('http://127.0.0.1:8090/health');
  });

  test('arg overrides apply last, only to the named launcher', () => {
    const file = writeToml(`${BASE}
[launchers.other]
extends = "gemma"
`);
    const config = loadStackConfig(file, { argOverrides: { gemma: { c: '32768', 'cont-batching': true } } });

    expect(config.launchers[0]?.commandLine).toContain('--ctx-size 32768');
    expect(config.launchers[0]?.commandLine).toContain('--cont-batching');
    expect(config.launchers[1]?.commandLine).toContain('--ctx-size 16384');
  });

  test('command kind appends args and exposes ${port}', () => {
    const file = writeToml(`
[launchers.comfy]
command = "python main.py --port \${port}"
port = 8188
args = { listen = "127.0.0.1", lowvram = true, "-x" = "a b" }
health = { url = "http://127.0.0.1:\${port}/system_stats" }
`);
    const [comfy] = loadStackConfig(file).launchers;

    expect(comfy?.commandLine).toBe("python main.py --port 8188 --listen 127.0.0.1 --lowvram -x 'a b'");
    expect(comfy?.health?.url).toBe('http://127.0.0.1:8188/system_stats');
  });

  test('unknown variables warn, except in command where bash expands them', () => {
    const file = writeToml(`
[launchers.a]
command = "run \${HOME}"
args = { model = "\${nope}/x.gguf" }
`);
    const config = loadStackConfig(file);

    expect(config.warnings).toEqual([{ level: 'warning', message: "launchers.a references unknown variable 'nope'" }]);
    expect(config.launchers[0]?.commandLine).toBe("run ${HOME} --model '${nope}/x.gguf'");
  });

  test('rejects an unknown parent and extends cycles', () => {
    expect(() => loadStackConfig(writeToml('[launchers.a]\nextends = "b"\n'))).toThrow(/extends unknown launcher 'b'/);
    expect(() => loadStackConfig(writeToml('[launchers.a]\nextends = "b"\n[launchers.b]\nextends = "a"\n'))).toThrow(/extends cycle/);
  });

  test('llama-server rejects host or port given as args', () => {
    const file = writeToml('[launchers.a]\nkind = "llama-server"\nargs = { port = 9000 }\n');

    expect(() => loadStackConfig(file)).toThrow(/use the port key/);
  });

  test('reports invalid TOML', () => {
    expect(() => loadStackConfig(writeToml('a = '))).toThrow(/invalid TOML/);
  });
});

describe('findMissingPaths', () => {
  test('lists absolute paths of the command line and cwd that do not exist', () => {
    const file = writeToml(`
[launchers.a]
kind = "llama-server"
command = "/bin/sh"
cwd = "/nonexistent/dir"
args = { model = "/nonexistent/model.gguf", path = "${tmpdir()}" }
`);
    const [launcher] = loadStackConfig(file).launchers;

    expect(findMissingPaths(launcher as Launcher)).toEqual(['/nonexistent/dir', '/nonexistent/model.gguf']);
  });
});
