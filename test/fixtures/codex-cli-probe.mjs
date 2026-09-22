import { writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const valueAfter = flag => args[args.indexOf(flag) + 1];
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', async () => {
  const output = valueAfter('--output-last-message');
  const result = { status: 'completed', summary: 'codex-cli-probe completed', changedFiles: [], typedOutputs: [] };
  await writeFile(output, `${JSON.stringify(result)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'probe-thread', temp: process.env.TEMP, args })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: prompt.length, output_tokens: 1 } })}\n`);
});
