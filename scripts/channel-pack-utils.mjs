import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sha256 } from '../src/common/canonical.mjs';
import { assert } from '../src/common/errors.mjs';
import { assertHarnessWritePath, temporaryEnvironment } from '../src/common/write-boundary.mjs';
import { parseLastJsonDocument } from './parse-json-output.mjs';

export const assertChannelContents = ({ channel, packedFiles, expectedFiles, forbiddenPrefixes = [] }) => {
  const packed = new Set(packedFiles);
  for (const file of expectedFiles) assert(packed.has(file), 'CHANNEL_PACK_FILE_MISSING', `${channel} archive is missing ${file}.`);
  for (const prefix of forbiddenPrefixes) assert(![...packed].some(file => file.startsWith(prefix)), 'CHANNEL_PACK_CROSS_CHANNEL_FILE', `${channel} archive contains ${prefix}.`);
  const expected = new Set(expectedFiles);
  for (const file of packed) assert(expected.has(file), 'CHANNEL_PACK_UNEXPECTED_FILE', `${channel} archive contains an undeclared file: ${file}.`);
};

export const packChannel = async ({ root, channel, source, npmCli, expectedFiles, forbiddenPrefixes = [], identity }) => {
  assert(typeof npmCli === 'string' && npmCli.length > 0, 'NPM_EXECUTABLE_REQUIRED', `pack:${channel} must be started through npm.`);
  const scratchRoot = assertHarnessWritePath(resolve(root, '.tmp', `pack-${channel}`), `${channel} pack scratch root`, root);
  const cache = assertHarnessWritePath(resolve(root, '.agent-harness-cache', 'npm'), `${channel} npm cache`, root);
  const outputRoot = assertHarnessWritePath(resolve(root, '.agent-harness-data', 'channel-packages', channel, identity), `${channel} package output`, root);
  await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(resolve(scratchRoot, 'run-'));
  try {
    await mkdir(cache, { recursive: true });
    const temporary = resolve(scratch, 'process-tmp');
    await mkdir(temporary, { recursive: true });
    const environment = {
      ...process.env,
      ...temporaryEnvironment(temporary, root),
      NPM_CONFIG_CACHE: cache,
      NPM_CONFIG_LOGS_DIR: resolve(scratch, 'npm-logs'),
      NPM_CONFIG_LOGS_MAX: '0',
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    };
    const output = await new Promise((resolveRun, reject) => {
      process.stderr.write(`[process:start] npm pack (${channel})\n`);
      const child = spawn(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', scratch], { cwd: source, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; process.stderr.write(`[process:output] npm pack (${channel}) received ${chunk.length} bytes\n`); });
      child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
      child.on('error', error => { process.stderr.write(`[process:error] npm pack (${channel}): ${error.message}\n`); reject(error); });
      child.on('close', (code, signal) => {
        process.stderr.write(`[process:finish] npm pack (${channel}) exit=${code ?? 'null'} signal=${signal ?? 'none'}\n`);
        code === 0 && !signal ? resolveRun(stdout) : reject(new Error(`npm pack for ${channel} failed: ${stderr.trim() || signal || code}`));
      });
    });
    const result = parseLastJsonDocument(output)?.[0];
    assert(result?.filename && Array.isArray(result.files), 'CHANNEL_PACK_RESULT_INVALID', `npm pack returned no ${channel} file list.`);
    assertChannelContents({ channel, packedFiles: result.files.map(file => file.path), expectedFiles, forbiddenPrefixes });
    const archiveBytes = await readFile(resolve(scratch, result.filename));
    const archiveDigest = sha256(archiveBytes);
    await mkdir(outputRoot, { recursive: true });
    const archive = resolve(outputRoot, `${channel}-${archiveDigest.slice(0, 16)}.tgz`);
    await cp(resolve(scratch, result.filename), archive);
    const receipt = {
      protocolVersion: '1.0', channel, identity, archive, archiveDigest,
      fileCount: result.files.length, npmIntegrity: result.integrity, npmShasum: result.shasum,
    };
    const receiptFile = resolve(outputRoot, `${channel}-package-receipt.json`);
    await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    return { ...receipt, receipt: receiptFile };
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await rmdir(scratchRoot).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
    await rmdir(resolve(root, '.tmp')).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
    await rm(cache, { recursive: true, force: true });
    await rmdir(resolve(root, '.agent-harness-cache')).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
  }
};
