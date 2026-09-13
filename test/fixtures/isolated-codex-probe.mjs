import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const marker = 'Dispatch packet:\n';
const packet = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length));
const changedFile = packet.feature.allowedPaths[0];
await mkdir(dirname(resolve(changedFile)), { recursive: true });
await writeFile(resolve(changedFile), `${packet.feature.id}\n`, 'utf8');
const result = { status: 'completed', summary: `isolated:${packet.feature.id}`, changedFiles: packet.feature.metadata?.omitChangedFiles ? [] : [changedFile] };
const outputIndex = process.argv.indexOf('--output-last-message');
await writeFile(process.argv[outputIndex + 1], `${JSON.stringify(result)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: `isolated-${packet.feature.id}`, temp: process.env.TEMP })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`);
