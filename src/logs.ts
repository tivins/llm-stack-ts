import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const TAIL_BYTES = 64 * 1024;

/** Returns the last `count` lines of a file (read from its last 64 KiB), or an empty array if it cannot be read. */
export function readLastLines(file: string, count: number): string[] {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return [];
  }

  let content: string;
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    content = buffer.toString('utf-8');
  } finally {
    closeSync(fd);
  }

  const lines = content.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines.slice(-count);
}
