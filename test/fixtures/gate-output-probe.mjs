import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const bytes = Number(process.argv[2] ?? 1);
const delayMs = Number(process.argv[3] ?? 0);
await mkdir(process.env.GATE_OUTPUT, { recursive: true });
await writeFile(resolve(process.env.GATE_OUTPUT, 'gate.bin'), Buffer.alloc(bytes, 1));
await new Promise(resolveWait => setTimeout(resolveWait, delayMs));
process.stdout.write(`gate-output=${process.env.GATE_OUTPUT}\n`);
