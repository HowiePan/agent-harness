import { execFileSync, spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert } from '../src/common/errors.mjs';
import { assertInside, assertNoLinkPath } from '../src/common/paths.mjs';
import { captureDevelopmentSourceIdentity } from '../src/application/development-source.mjs';

// An unpublished build/test artifact, not another checkout or a release re-sign.
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parent = assertInside(sourceRoot, resolve(sourceRoot, '.tmp'), 'candidate parent');
await mkdir(parent, { recursive: true });
const candidateRoot = await mkdtemp(resolve(parent, 'bd-'));
const before = await captureDevelopmentSourceIdentity({ sourceRoot });
const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: sourceRoot, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean);
for (const path of new Set(paths)) {
  const source = assertNoLinkPath(sourceRoot, resolve(sourceRoot, path), 'candidate source');
  const target = assertInside(candidateRoot, resolve(candidateRoot, path), 'candidate file');
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}
const run = args => new Promise((resolveExit, reject) => {
  const child = spawn(process.execPath, args, { cwd: candidateRoot, windowsHide: true, stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', code => resolveExit(code ?? 1));
});
assert(await run(['scripts/build-release-metadata.mjs']) === 0, 'DEVELOPMENT_CANDIDATE_BUILD_FAILED', 'Temporary candidate metadata generation failed.');
console.log(JSON.stringify({ kind: 'development-candidate-started', candidateRoot, sourceDigest: before.sourceDigest }));
const exitCode = await run(['scripts/run-tests.mjs', 'all']);
const after = await captureDevelopmentSourceIdentity({ sourceRoot });
const receipt = { kind: 'development-candidate-verification', candidateRoot, sourceRoot,
  sourceDigest: before.sourceDigest, runtimeDigest: before.runtimeDigest, supportDigest: before.supportDigest,
  sourceUnchanged: before.sourceDigest === after.sourceDigest, exitCode, published: false, sourceManifestModified: false };
await writeFile(resolve(parent, 'bounded-delivery-candidate.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt));
process.exitCode = exitCode || (receipt.sourceUnchanged ? 0 : 1);
