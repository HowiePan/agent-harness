import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const packet = JSON.parse(input.trim().split(/\r?\n/)[0]);
await mkdir(process.env.PROBE_OUTPUT, { recursive: true });
await writeFile(resolve(process.env.PROBE_OUTPUT, 'payload.bin'), Buffer.alloc(packet.bytes, 1));
await new Promise(resolveWait => setTimeout(resolveWait, packet.delayMs ?? 0));
process.stdout.write(`${JSON.stringify({ status: 'completed', summary: 'managed-output-probe', outputRoot: process.env.PROBE_OUTPUT, sandboxed: process.env.SANDBOXED === 'true' })}\n`);
