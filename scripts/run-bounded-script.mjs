#!/usr/bin/env node
import { lstat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert } from '../src/common/errors.mjs';
import { readBoundedJson, resolveResourceLimits, runResourceBounded, SCRIPT_RESOURCE_LIMITS } from '../src/platform/plugins/execution/resource-guard.mjs';
import { harnessControlRoot } from '../src/common/write-boundary.mjs';

export const validateScriptRequest = async request => {
  assert(request?.schemaVersion === 'bounded-script/1', 'SCRIPT_REQUEST_INVALID', 'Use bounded-script/1.');
  const limits = resolveResourceLimits(request.limits);
  assert(Object.entries(limits).every(([key, value]) => key === 'timeoutMs' || value <= SCRIPT_RESOURCE_LIMITS[key]),
    'SCRIPT_SPLIT_REQUIRED', 'Agent scripts may tighten limits, never raise them; split work.');
  assert(isAbsolute(request.cwd ?? '') && isAbsolute(request.executable ?? ''), 'SCRIPT_PATH_INVALID', 'cwd and executable must be absolute.');
  assert(Array.isArray(request.args) && request.args.every(value => typeof value === 'string')
    && isAbsolute(request.script ?? '') && request.args.includes(request.script), 'SCRIPT_ENTRY_REQUIRED', 'Declare a script file and pass that exact absolute path as an argument; inline programs are prohibited.');
  assert(Array.isArray(request.inputs) && request.inputs.length > 0 && request.inputs.length <= limits.maxInputFiles,
    'SCRIPT_SPLIT_REQUIRED', 'Declare at most 128 exact input files per shard; split larger work.');
  assert(new Set(request.inputs).size === request.inputs.length && request.inputs.includes(request.script), 'SCRIPT_INPUTS_INVALID', 'Unique inputs must include the script.');
  assert(typeof request.shard?.id === 'string' && request.shard.id.length > 0
    && typeof request.shard?.checkpoint === 'string' && request.shard.checkpoint.length > 0,
  'SCRIPT_CHECKPOINT_REQUIRED', 'Each shard needs an ID and an output/checkpoint description for safe resumption.');
  let inputBytes = 0;
  for (const path of request.inputs) {
    assert(typeof path === 'string' && isAbsolute(path), 'SCRIPT_INPUTS_INVALID', 'Use exact absolute files, not directory walks or globs.');
    const info = await lstat(path);
    assert(info.isFile() && !info.isSymbolicLink(), 'SCRIPT_INPUTS_INVALID', 'Inputs must be regular files.');
    inputBytes += info.size;
    assert(inputBytes <= limits.maxInputBytes && (path !== request.script || info.size <= limits.maxScriptBytes),
      'SCRIPT_SPLIT_REQUIRED', 'Input/script byte budget exceeded; split work before launch.');
  }
  return { limits, inputBytes, inputFiles: request.inputs.length };
};

export const executeScriptRequest = async request => {
  const inventory = await validateScriptRequest(request);
  const root = harnessControlRoot(request.controlRoot);
  const result = await runResourceBounded({ launch: { executable: request.executable, args: request.args, cwd: request.cwd,
    environment: process.env }, limits: inventory.limits, resourceRoot: resolve(root, '.tmp', 'bounded-processes') });
  return { ...result, shard: request.shard, inputBytes: inventory.inputBytes, inputFiles: inventory.inputFiles };
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert(process.argv.length === 4 && process.argv[2] === '--request', 'SCRIPT_USAGE', 'Usage: node scripts/run-bounded-script.mjs --request <request.json>');
    const request = await readBoundedJson(resolve(process.argv[3]), 64 * 1024);
    const result = await executeScriptRequest(request);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.exitCode === 0 && !result.environmentError ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'blocked', code: error.code ?? 'SCRIPT_FAILED', message: error.message })}\n`);
    process.exitCode = 1;
  }
}
