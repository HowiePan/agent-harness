if (process.argv.includes('--fail')) {
  console.error('gate failed');
  process.exitCode = 2;
} else console.log(`gate passed temp=${process.env.TEMP}`);
