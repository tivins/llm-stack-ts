import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { canonicalLlamaArgs, parseArgTokens, renderArgs, tokenize } from '../src/args';

describe('tokenize', () => {
  test('splits on whitespace and honours quotes and backslashes', () => {
    expect(tokenize(`a  'b c' "d \\"e\\"" f\\ g`)).toEqual(['a', 'b c', 'd "e"', 'f g']);
  });

  test('returns null on shell syntax it does not model', () => {
    for (const command of ['a | b', 'a > log', 'a $HOME', 'a "$HOME"', 'a; b', 'a ~/x', "a 'unclosed"]) {
      expect(tokenize(command)).toBeNull();
    }
  });
});

describe('parseArgTokens', () => {
  test('reads flags, values, bare switches, negative numbers and repeated flags', () => {
    expect(parseArgTokens(['-m', 'x.gguf', '--embedding', '--temp', '-1', '-fa', 'on', '--lora', 'a', '--lora', 'b'])).toEqual({
      m: 'x.gguf',
      embedding: true,
      temp: '-1',
      '-fa': 'on',
      lora: ['a', 'b'],
    });
  });

  test('returns null for positional arguments and --key=value', () => {
    expect(parseArgTokens(['main.py'])).toBeNull();
    expect(parseArgTokens(['--port=8080'])).toBeNull();
  });
});

describe('canonicalLlamaArgs', () => {
  test('maps short llama-server flags to their long names', () => {
    expect(canonicalLlamaArgs({ m: 'x', c: 1, '-fa': 'on', np: 1, ngl: 99, temp: 1 })).toEqual({
      model: 'x',
      'ctx-size': 1,
      'flash-attn': 'on',
      parallel: 1,
      'n-gpu-layers': 99,
      temp: 1,
    });
  });
});

describe('renderArgs', () => {
  test('renders flags, skips false, repeats arrays, quotes and expands ~', () => {
    expect(renderArgs({ m: 'a b', 'ctx-size': 2048, embedding: true, off: false, lora: ['x', 'y'], path: '~/ui', '-fa': 'on' })).toEqual([
      '-m',
      "'a b'",
      '--ctx-size',
      '2048',
      '--embedding',
      '--lora',
      'x',
      '--lora',
      'y',
      '--path',
      `${homedir()}/ui`,
      '-fa',
      'on',
    ]);
  });
});
