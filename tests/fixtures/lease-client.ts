/**
 * Child process for the GPU lease tests.
 *   hold <dir>                    take the lease, print "held", keep it until killed
 *   log <dir> <file> <rounds>     take the lease `rounds` times, appending "start <pid>" / "end <pid>" to <file>
 */
import { appendFileSync } from 'node:fs';
import { GpuLock } from '../../src/GpuLock';

const [mode, dir, file, rounds] = process.argv.slice(2);
if (dir === undefined) throw new Error('missing lock dir');
const lock = new GpuLock(dir, { pollMs: 5 });

if (mode === 'hold') {
  await lock.acquire({ holder: `child ${process.pid}` });
  console.log('held');
  setInterval(() => {}, 1000);
} else if (mode === 'log' && file !== undefined) {
  for (let round = 0; round < Number(rounds ?? 1); round++) {
    await lock.withLease({ holder: `child ${process.pid}` }, async () => {
      appendFileSync(file, `start ${process.pid}\n`);
      await Bun.sleep(15);
      appendFileSync(file, `end ${process.pid}\n`);
    });
  }
} else {
  throw new Error(`unknown mode ${mode}`);
}
