import { access, copyFile, mkdir, readFile, rename, rm, rmdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { digestJson, newId } from '../canonical.mjs';
import { assert } from '../errors.mjs';
import { atomicWriteJson } from '../kernel/atomic-io.mjs';
import { assertInside, safeSegment } from '../paths.mjs';
import { assertHarnessWritePath } from '../write-boundary.mjs';
import { inventoryTree } from './inventory.mjs';

const forbiddenExecutableExtensions = new Set(['.bat', '.cmd', '.com', '.cjs', '.dll', '.exe', '.js', '.mjs', '.msi', '.pdb', '.ps1', '.py', '.rs', '.sh', '.ts', '.tsx']);

const absent = async path => {
  try { await access(path); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
};

export const createRecoveryCapsule = async ({ legacyRoot, dataRoot, controlRoot, importer, capsuleId, commandId, maxBytes = 512 * 1024 * 1024, maxFiles = 100_000, now = () => new Date().toISOString() }) => {
  assert(importer?.id && importer?.version && typeof importer.inventory === 'function', 'RECOVERY_CAPSULE_IMPORTER_INVALID', 'Recovery Capsule requires a versioned Legacy Importer.');
  assert(commandId, 'COMMAND_ID_REQUIRED', 'Recovery Capsule creation requires a command ID.');
  const controlledDataRoot = assertHarnessWritePath(dataRoot, 'Recovery Capsule data root', controlRoot);
  const id = safeSegment(capsuleId, 'capsuleId');
  const finalRoot = assertHarnessWritePath(resolve(controlledDataRoot, 'migrations', 'capsules', id), 'Recovery Capsule root', controlRoot);
  assert(await absent(finalRoot), 'RECOVERY_CAPSULE_EXISTS', `Recovery Capsule already exists: ${id}`);
  const staging = assertHarnessWritePath(resolve(controlledDataRoot, 'tmp', 'recovery-capsules', newId(id)), 'Recovery Capsule staging root', controlRoot);
  const payloadRoot = resolve(staging, 'payload');
  try {
    const inventory = await inventoryTree(legacyRoot);
    const totalBytes = inventory.files.reduce((sum, file) => sum + file.size, 0);
    assert(inventory.files.length <= maxFiles, 'RECOVERY_CAPSULE_FILE_BUDGET_EXCEEDED', 'Legacy state exceeds the Recovery Capsule file budget.', { files: inventory.files.length, maxFiles });
    assert(totalBytes <= maxBytes, 'RECOVERY_CAPSULE_BYTE_BUDGET_EXCEEDED', 'Legacy state exceeds the Recovery Capsule byte budget.', { bytes: totalBytes, maxBytes });
    const forbidden = inventory.files.filter(file => forbiddenExecutableExtensions.has(extname(file.path).toLowerCase())).map(file => file.path);
    assert(forbidden.length === 0, 'RECOVERY_CAPSULE_EXECUTABLE_REJECTED', 'Recovery Capsules cannot contain executable source or binary files.', { forbidden });
    const assessment = await importer.inventory({ legacyRoot });
    await mkdir(payloadRoot, { recursive: true });
    for (const file of inventory.files) {
      const source = assertInside(inventory.root, resolve(inventory.root, file.path), 'legacy capsule source');
      const target = assertInside(payloadRoot, resolve(payloadRoot, file.path), 'legacy capsule target');
      await mkdir(resolve(target, '..'), { recursive: true });
      await copyFile(source, target);
    }
    const body = {
      protocolVersion: '1.0',
      capsuleId: id,
      commandId,
      createdAt: now(),
      importer: { id: importer.id, version: importer.version },
      sourceDigest: inventory.sourceDigest,
      assessmentDigest: assessment.assessmentDigest,
      fileCount: inventory.files.length,
      totalBytes,
      files: inventory.files,
      executableContent: false,
      retention: 'user-controlled',
    };
    const manifest = { ...body, manifestDigest: digestJson(body) };
    await atomicWriteJson(resolve(staging, 'capsule.json'), manifest, { root: controlledDataRoot });
    await atomicWriteJson(resolve(staging, 'assessment.json'), assessment, { root: controlledDataRoot });
    await mkdir(resolve(finalRoot, '..'), { recursive: true });
    await rename(staging, finalRoot);
    return { root: finalRoot, payloadRoot: resolve(finalRoot, 'payload'), manifest, assessment };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  } finally {
    for (const path of [resolve(controlledDataRoot, 'tmp', 'recovery-capsules'), resolve(controlledDataRoot, 'tmp')]) await rmdir(path).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
  }
};

export const verifyRecoveryCapsule = async (capsuleRootInput, { controlRoot } = {}) => {
  const capsuleRoot = assertHarnessWritePath(capsuleRootInput, 'Recovery Capsule root', controlRoot);
  const manifest = JSON.parse(await readFile(resolve(capsuleRoot, 'capsule.json'), 'utf8'));
  const assessment = JSON.parse(await readFile(resolve(capsuleRoot, 'assessment.json'), 'utf8'));
  const { manifestDigest, ...body } = manifest;
  assert(manifestDigest === digestJson(body), 'RECOVERY_CAPSULE_MANIFEST_MISMATCH', 'Recovery Capsule manifest digest mismatch.');
  const payloadRoot = resolve(capsuleRoot, 'payload');
  const inventory = await inventoryTree(payloadRoot);
  const forbidden = inventory.files.filter(file => forbiddenExecutableExtensions.has(extname(file.path).toLowerCase())).map(file => file.path);
  assert(forbidden.length === 0 && manifest.executableContent === false, 'RECOVERY_CAPSULE_EXECUTABLE_REJECTED', 'Recovery Capsule contains executable source or binary files.', { forbidden });
  assert(inventory.sourceDigest === manifest.sourceDigest, 'RECOVERY_CAPSULE_SOURCE_MISMATCH', 'Recovery Capsule payload digest mismatch.');
  assert(inventory.files.length === manifest.fileCount, 'RECOVERY_CAPSULE_FILE_COUNT_MISMATCH', 'Recovery Capsule file count mismatch.');
  assert(assessment.assessmentDigest === manifest.assessmentDigest, 'RECOVERY_CAPSULE_ASSESSMENT_MISMATCH', 'Recovery Capsule assessment digest mismatch.');
  return { root: capsuleRoot, payloadRoot, manifest, assessment };
};
