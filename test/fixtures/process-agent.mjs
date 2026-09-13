let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const packet = JSON.parse(input.trim().split(/\r?\n/)[0]);
  process.stdout.write(`${JSON.stringify({ status: 'completed', summary: `processed:${packet.dispatchId}`, temp: process.env.TEMP })}\n`);
});
