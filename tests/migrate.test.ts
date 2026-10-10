import { describe, expect, test } from 'bun:test';
import { parseStackConfig } from '../src/config';
import { migrateStackConfig } from '../src/migrate';

const LLAMA = '/opt/bin/llama-server';

function legacy(launchers: Record<string, unknown>[]): unknown {
  return { vram_capacity_gb: 16, launchers };
}

describe('migrateStackConfig', () => {
  test('turns same-model launchers into variants and shares common settings in a base', () => {
    const source = legacy([
      {
        name: 'gemma',
        type: 'text-generation',
        command: `${LLAMA} -m /data/models/gemma.gguf -c 16384 --reasoning-budget 6144 -fa on --host 127.0.0.1 --port 8080`,
        vram_gb: 14,
        health: { url: 'http://127.0.0.1:8080/health' },
      },
      {
        name: 'gemma_long',
        type: 'text-generation',
        command: `${LLAMA} -m /data/models/gemma.gguf --ctx-size 65536 -fa on`,
        vram_gb: 14,
        health: { url: 'http://127.0.0.1:8080/health' },
      },
      {
        name: 'qwen',
        type: 'text-generation',
        command: `${LLAMA} -m /data/models/sub/qwen.gguf -c 8192 -fa on --port 8080`,
        vram_gb: 14,
        health: { url: 'http://127.0.0.1:8080/health' },
      },
    ]);

    const result = migrateStackConfig(source);

    expect(result.mismatches).toEqual([]);
    expect(result.notes).toEqual([]);
    const doc = Bun.TOML.parse(result.toml) as Record<string, any>;
    expect(doc.vars).toEqual({ llama_server: LLAMA, models: '/data/models' });
    expect(doc.launchers._llama).toEqual({
      abstract: true,
      kind: 'llama-server',
      command: '${llama_server}',
      type: 'text-generation',
      vram_gb: 14,
      args: { 'flash-attn': 'on' },
    });
    expect(doc.launchers.gemma_long).toEqual({ extends: 'gemma', args: { 'ctx-size': 65536, 'reasoning-budget': false } });
    expect(doc.launchers.qwen.args.model).toBe('${models}/sub/qwen.gguf');
  });

  test('keeps non llama-server commands verbatim and maps legacy keys', () => {
    const source = {
      vram_capacity_in_gigabytes: 16,
      launchers: [
        { name: 'comfy', command: 'python main.py | tee x', minimal_video_ram_usage_in_gigabytes: 14, allow_full_cpu: false },
        { name: 'tts', command: '/opt/tts', allow_full_cpu: true, oops: 1 },
      ],
    };

    const result = migrateStackConfig(source);

    expect(result.mismatches).toEqual([]);
    expect(result.notes).toEqual(["tts: unknown key 'oops' dropped"]);
    const doc = Bun.TOML.parse(result.toml) as Record<string, any>;
    expect(doc.vram_capacity_gb).toBe(16);
    expect(doc.launchers.comfy).toEqual({ command: 'python main.py | tee x', vram_gb: 14 });
    expect(doc.launchers.tts).toEqual({ command: '/opt/tts', gpu: false });
  });

  test('notes the health check added to llama-server launchers that had none', () => {
    const result = migrateStackConfig(legacy([{ name: 'embed', command: 'llama-server -m /m.gguf --port 8081', gpu: false }]));

    expect(result.mismatches).toEqual([]);
    expect(result.notes).toEqual(['embed: health check added (http://127.0.0.1:8081/health), `start` now waits for it']);
  });

  test('a launcher whose parent sets something it cannot unset stays standalone', () => {
    const result = migrateStackConfig(
      legacy([
        { name: 'a', command: 'llama-server -m /m.gguf', cwd: '/tmp', health: { url: 'http://127.0.0.1:8080/health' } },
        { name: 'b', command: 'llama-server -m /m.gguf -c 4096', health: { url: 'http://127.0.0.1:8080/health' } },
      ]),
    );

    expect(result.mismatches).toEqual([]);
    const doc = Bun.TOML.parse(result.toml) as Record<string, any>;
    expect(doc.launchers.b.extends).not.toBe('a');
    expect(parseStackConfig(doc, 'test').launchers.find((l) => l.name === 'b')?.cwd).toBeUndefined();
  });

  test('refuses a file already using the launchers table', () => {
    expect(() => migrateStackConfig({ launchers: { a: { command: 'true' } } })).toThrow(/already uses/);
  });
});
