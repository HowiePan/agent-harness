#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const violations = [];

const walk = async (directory, predicate) => {
  if (!existsSync(directory)) return [];
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(path, predicate));
    else if (predicate(path)) output.push(path);
  }
  return output;
};

const checkFile = async (path, maxLines, maxBytes = 0) => {
  if (!existsSync(path)) return;
  const content = await readFile(path, 'utf8');
  const lines = content.split(/\r?\n/).length - (content.endsWith('\n') ? 1 : 0);
  const bytes = (await stat(path)).size;
  if (lines > maxLines || (maxBytes && bytes > maxBytes)) violations.push({ path, lines, maxLines, bytes, maxBytes: maxBytes || null });
};

await checkFile(resolve(root, 'AGENTS.md'), 80);
const skills = await walk(resolve(root, '.agent', 'skills'), path => path.endsWith('.md'));
if (skills.length > 7) violations.push({ path: resolve(root, '.agent', 'skills'), count: skills.length, maxCount: 7 });
for (const path of skills) await checkFile(path, 200, 8 * 1024);
for (const path of await walk(resolve(root, 'card_world_engine', 'src'), value => value.endsWith('.rs'))) {
  await checkFile(path, 3000);
  const content = await readFile(path, 'utf8');
  const marker = content.indexOf('#[cfg(test)]');
  if (marker < 0) continue;
  const open = content.indexOf('{', marker);
  let depth = 0;
  let close = -1;
  for (let index = open; open >= 0 && index < content.length; index += 1) {
    if (content[index] === '{') depth += 1;
    if (content[index] === '}' && --depth === 0) { close = index; break; }
  }
  if (close > open) {
    const inlineTestLines = content.slice(marker, close + 1).split(/\r?\n/).length;
    if (inlineTestLines > 200) violations.push({ path, inlineTestLines, maxInlineTestLines: 200 });
  }
}
for (const path of await walk(resolve(root, 'card_world_engine', 'tests'), value => value.endsWith('.rs'))) await checkFile(path, 1500);

if (violations.length) {
  process.stderr.write(`${JSON.stringify({ status: 'failed', violations }, null, 2)}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({ status: 'passed', summary: 'Context budgets are within limits.' })}\n`);
}
