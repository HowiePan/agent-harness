import { posix } from 'node:path';

export const CARGO_INPUT_BINDING = Object.freeze({ id: 'cargo-test-target-input', version: '1.0.0' });

// This deliberately accepts a small, unambiguous subset of manifest syntax.
// Unsupported syntax is a missing proof, never permission to guess a filename.
export const cargoTestInputCandidate = ({ manifestPath, content, command, declaredPath }) => {
  const selectors = [];
  for (let i = 0; i < command.length; i += 1) {
    if (command[i] === '--test') selectors.push(command[++i]);
    else if (command[i].startsWith('--test=')) selectors.push(command[i].slice(7));
  }
  if (selectors.length !== 1 || !/^[\w-]+$/.test(selectors[0] ?? '')) return null;
  const name = selectors[0];
  const directory = posix.dirname(manifestPath);
  const fromManifest = value => posix.normalize(posix.join(directory, value));
  if (declaredPath !== fromManifest(`tests/${name}.rs`)) return null;
  // Multiline strings can contain fake table headers. Reject the whole input.
  if (content.includes('"""') || content.includes("'''")) return null;
  const targets = [];
  let target = null;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      target = /^\[\[test\]\]\s*(?:#.*)?$/.test(line) ? {} : null;
      if (target) targets.push(target);
      continue;
    }
    if (!target) continue;
    if (/^["']?(?:name|path)["']?\s*[.=]/.test(line) && !/^(?:name|path)\s*=/.test(line)) return null;
    if (!/^(?:name|path)\s*=/.test(line)) continue;
    const match = /^(name|path)\s*=\s*(["'])([\w./-]+)\2\s*(?:#.*)?$/.exec(line);
    if (!match || Object.hasOwn(target, match[1])) return null;
    target[match[1]] = match[3];
  }
  const matches = targets.filter(item => item.name === name);
  if (matches.length !== 1 || !matches[0].path) return null;
  const path = matches[0].path;
  if (path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')
    || posix.basename(path) !== `${name}.rs`) return null;
  const resolvedPath = fromManifest(path);
  return resolvedPath === declaredPath ? null : { resolvedPath, targetName: name, resolver: CARGO_INPUT_BINDING };
};
