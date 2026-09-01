/**
 * Copy non-TypeScript assets into dist.
 *
 * `tsc` emits only JavaScript, so the hardware fixtures — which are loaded at
 * runtime by path — would be missing from a built package without this.
 */
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const from = path.join(root, 'src', 'hardware', 'fixtures');
const to = path.join(root, 'dist', 'hardware', 'fixtures');

await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });
process.stdout.write(`copied hardware fixtures to ${path.relative(root, to)}\n`);
