export const parseLastJsonDocument = output => {
  const text = String(output ?? '').replace(/^\uFEFF/, '');
  const starts = [];
  for (const match of text.matchAll(/(?:^|\r?\n)([\[{])/g)) {
    starts.push(match.index + match[0].length - 1);
  }
  for (const start of starts.reverse()) {
    try {
      return JSON.parse(text.slice(start).trim());
    } catch {
      // Lifecycle scripts may emit earlier JSON documents; keep looking.
    }
  }
  const error = new SyntaxError('Command output does not end with a valid JSON document.');
  error.code = 'COMMAND_JSON_OUTPUT_INVALID';
  throw error;
};
