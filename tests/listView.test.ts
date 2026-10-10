import { describe, expect, test } from 'bun:test';
import { parseStackConfig } from '../src/config';
import { formatLauncherList } from '../src/listView';

const CONFIG = Bun.TOML.parse(`
[launchers._llama]
abstract = true
kind = "llama-server"
type = "text-generation"
vram_gb = 14
args = { flash-attn = "on" }

[launchers.gemma]
extends = "_llama"
args = { model = "/m/gemma-4-26B-IQ4_NL.gguf", ctx-size = 16384, reasoning-budget = 6144, temp = 0.7 }

[launchers.comfyui]
type = "image"
command = "/venv/bin/python main.py"
vram_gb = 14
health = { url = "http://127.0.0.1:8188/system_stats" }

[launchers.gemma_32k]
extends = "gemma"
description = "long context"
args = { ctx-size = 32768, reasoning-budget = false }

[launchers.rerank]
kind = "llama-server"
port = 8082
vram_gb = 0.6
exclusive = false
args = { model = "/m/a-very-long-reranker-model-name-with-many-parts-q8_0.gguf", reranking = true }
`);

describe('formatLauncherList', () => {
  test('groups by type, nests variants under their parent and shows only what they change', () => {
    const { launchers } = parseStackConfig(CONFIG, 'test');

    const output = formatLauncherList(launchers, (name) => name === 'gemma_32k');

    expect(output.split('\n')).toEqual([
      '  NAME         MODEL                                 CTX  REASON  PORT   VRAM  DETAILS',
      'text-generation',
      '  gemma        gemma-4-26B-IQ4_NL                    16k      6k  8080   14GB  temp=0.7',
      '* └ gemma_32k                                        32k       -  8080   14GB  long context',
      'image',
      '  comfyui      -                                       -       -  8188   14GB  python main.py',
      'other',
      '  rerank       a-very-long-rerank…h-many-parts-q8_0    -       -  8082  0.6GB  shared-gpu reranking',
    ]);
  });

  test('reads model, context and reasoning budget back from a legacy llama-server command', () => {
    const { launchers } = parseStackConfig(
      { launchers: [{ name: 'llm', command: '/bin/llama-server -m /m/qwen.gguf -c 8192 --reasoning-budget -1 -fa on --port 8081' }] },
      'test',
    );

    expect(formatLauncherList(launchers, () => false).split('\n')[2]).toBe('  llm   qwen    8k       ∞  8081   0GB  flash-attn=on');
  });

  test('cuts the last column to the terminal width', () => {
    const { launchers } = parseStackConfig(CONFIG, 'test');

    const lines = formatLauncherList(launchers, () => false, { width: 85 }).split('\n');

    expect(lines.every((line) => line.length <= 85)).toBe(true);
    expect(lines[5]).toEndWith('pytho…');
  });
});
