/**
 * Child process for the GPU lease tests.
 *   hold <dir>                    take the lease, print "held", keep it until killed
 *   log <dir> <file> <rounds> [priority] [launcher]
 *                                 take the lease `rounds` times, appending "start <pid>" / "end <pid>" to <file>
 */
import { appendFileSync } from 'node:fs';
import { GpuLock } from '../../src/GpuLock';

const [mode, dir, file, rounds, priority, launcher] = process.argv.slice(2);
if (dir === undefined) throw new Error('missing lock dir');
const lock = new GpuLock(dir, { pollMs: 5 });

if (mode === 'hold') {
  await lock.acquire({ holder: `child ${process.pid}` });
  console.log('held');
  setInterval(() => {}, 1000);
} else if (mode === 'log' && file !== undefined) {
  for (let round = 0; round < Number(rounds ?? 1); round++) {
    const options = { priority: Number(priority ?? 1) as 0 | 1 | 2, launcher, idleMs: 0 };
    await lock.withLease({ holder: `child ${process.pid}`, ...options }, async () => {
      appendFileSync(file, `start ${process.pid}\n`);
      await Bun.sleep(15);
      appendFileSync(file, `end ${process.pid}\n`);
    });
  }
} else {
  throw new Error(`unknown mode ${mode}`);
}
