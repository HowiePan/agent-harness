#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const AGENTS_MAX_LINES = 80;
const SKILL_MAX_LINES = 200;
const SKILL_MAX_BYTES = 32 * 1024;
const SKILL_MAX_COUNT = 7;
const SKILL_ROOTS = ['integrations/codex/agent-harness-codex/skills'];

const lineCount = content => content.split(/\r?\n/).length - (content.endsWith('\n') ? 1 : 0);

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

export const checkContextBudget = async root => {
  const errors = [];
  const agents = resolve(root, 'AGENTS.md');
  if (existsSync(agents) && lineCount(await readFile(agents, 'utf8')) > AGENTS_MAX_LINES) {
    errors.push(`AGENTS.md exceeds the ${AGENTS_MAX_LINES}-line context budget`);
  }
  for (const relative of SKILL_ROOTS) {
    const directory = resolve(root, relative);
    const markdown = await walk(directory, path => path.endsWith('.md'));
    const skills = markdown.filter(path => path.endsWith('SKILL.md'));
    if (skills.length > SKILL_MAX_COUNT) errors.push(`${relative} contains ${skills.length} Skills; the budget allows ${SKILL_MAX_COUNT}`);
    for (const path of markdown) {
      const content = await readFile(path, 'utf8');
      const lines = lineCount(content);
      const bytes = (await stat(path)).size;
      if (lines > SKILL_MAX_LINES) errors.push(`${relative} entry exceeds the ${SKILL_MAX_LINES}-line budget: ${path.slice(root.length + 1)} (${lines})`);
      if (bytes > SKILL_MAX_BYTES) errors.push(`${relative} entry exceeds the ${SKILL_MAX_BYTES}-byte budget: ${path.slice(root.length + 1)} (${bytes})`);
    }
  }
  return errors;
};

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const errors = await checkContextBudget(resolve(fileURLToPath(import.meta.url), '..', '..'));
  if (errors.length) {
    process.stderr.write(`${JSON.stringify({ status: 'failed', errors }, null, 2)}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify({ status: 'passed', summary: 'Context budgets are within limits.' })}\n`);
  }
}
