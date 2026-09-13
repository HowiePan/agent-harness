import { readFileSync } from 'node:fs';
import { access, copyFile, lstat, mkdir, readFile, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { digestJson, newId } from '../canonical.mjs';
import { assert } from '../errors.mjs';
import { assertJsonSchema } from '../json-schema.mjs';
import { atomicWriteJson } from '../kernel/atomic-io.mjs';
import { assertInside, safeSegment } from '../paths.mjs';
import { assertHarnessWritePath } from '../write-boundary.mjs';
import { inventoryTree } from './inventory.mjs';

const forbiddenExecutableExtensions = new Set(['.bat', '.cmd', '.com', '.cjs', '.dll', '.exe', '.js', '.mjs', '.msi', '.pdb', '.ps1', '.py', '.rs', '.sh', '.ts', '.tsx']);
const capsuleSchema = JSON.parse(readFileSync(new URL('../../schemas/recovery-capsule.schema.json', import.meta.url), 'utf8'));
const assessmentSchema = JSON.parse(readFileSync(new URL('../../schemas/migration-manifest.schema.json', import.meta.url), 'utf8'));

const absent = async path => {
  try { await access(path); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
};

const totalBytes = inventory => inventory.files.reduce((sum, file) => sum + file.size, 0);
const forbiddenFiles = inventory => inventory.files.filter(file => forbiddenExecutableExtensions.has(extname(file.path).toLowerCase())).map(file => file.path);

const assertAssessment = (assessment, { importer, sourceDigest, fileCount, legacyRoot = 'payload' }) => {
  assertJsonSchema(assessment, assessmentSchema, { code: 'RECOVERY_CAPSULE_ASSESSMENT_SCHEMA_INVALID', label: 'Recovery Capsule assessment' });
  const { assessmentDigest, ...body } = assessment;
  assert(assessmentDigest === digestJson(body), 'RECOVERY_CAPSULE_ASSESSMENT_MISMATCH', 'Recovery Capsule assessment digest mismatch.');
  assert(assessment.importer.id === importer.id && assessment.importer.version === importer.version, 'RECOVERY_CAPSULE_IMPORTER_MISMATCH', 'Recovery Capsule assessment importer does not match the manifest.');
  assert(assessment.sourceDigest === sourceDigest && assessment.fileCount === fileCount && assessment.legacyRoot === legacyRoot, 'RECOVERY_CAPSULE_ASSESSMENT_CONTEXT_MISMATCH', 'Recovery Capsule assessment does not match its staged payload.');
};

const assertCapsuleLayout = async capsuleRoot => {
  const entries = await readdir(capsuleRoot, { withFileTypes: true });
  const actual = entries.map(entry => entry.name).sort();
  assert(JSON.stringify(actual) === JSON.stringify(['assessment.json', 'capsule.json', 'payload']), 'RECOVERY_CAPSULE_LAYOUT_INVALID', 'Recovery Capsule contains missing or unknown top-level entries.', { actual });
  for (const entry of entries) {
    const info = await lstat(resolve(capsuleRoot, entry.name));
    assert(!info.isSymbolicLink(), 'RECOVERY_LINK_FORBIDDEN', 'Recovery Capsule may not contain symbolic links or junctions.', { path: entry.name });
    if (entry.name === 'payload') assert(info.isDirectory(), 'RECOVERY_CAPSULE_LAYOUT_INVALID', 'Recovery Capsule payload must be a directory.');
    else assert(info.isFile(), 'RECOVERY_CAPSULE_LAYOUT_INVALID', `Recovery Capsule ${entry.name} must be a regular file.`);
  }
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
    const sourceBefore = await inventoryTree(legacyRoot);
    const sourceBytes = totalBytes(sourceBefore);
    assert(sourceBefore.files.length <= maxFiles, 'RECOVERY_CAPSULE_FILE_BUDGET_EXCEEDED', 'Legacy state exceeds the Recovery Capsule file budget.', { files: sourceBefore.files.length, maxFiles });
    assert(sourceBytes <= maxBytes, 'RECOVERY_CAPSULE_BYTE_BUDGET_EXCEEDED', 'Legacy state exceeds the Recovery Capsule byte budget.', { bytes: sourceBytes, maxBytes });
    const forbidden = forbiddenFiles(sourceBefore);
    assert(forbidden.length === 0, 'RECOVERY_CAPSULE_EXECUTABLE_REJECTED', 'Recovery Capsules cannot contain executable source or binary files.', { forbidden });
    await mkdir(payloadRoot, { recursive: true });
    for (const file of sourceBefore.files) {
      const source = assertInside(sourceBefore.root, resolve(sourceBefore.root, file.path), 'legacy capsule source');
      const target = assertInside(payloadRoot, resolve(payloadRoot, file.path), 'legacy capsule target');
      await mkdir(resolve(target, '..'), { recursive: true });
      await copyFile(source, target);
    }
    const staged = await inventoryTree(payloadRoot);
    assert(staged.sourceDigest === sourceBefore.sourceDigest, 'RECOVERY_CAPSULE_COPY_MISMATCH', 'Recovery Capsule staging payload does not match the source inventory.');
    const rawAssessment = await importer.inventory({ legacyRoot: payloadRoot });
    const { assessmentDigest: ignoredAssessmentDigest, ...rawAssessmentBody } = rawAssessment;
    const assessmentBody = { ...rawAssessmentBody, legacyRoot: 'payload' };
    const assessment = { ...assessmentBody, assessmentDigest: digestJson(assessmentBody) };
    assertAssessment(assessment, { importer, sourceDigest: staged.sourceDigest, fileCount: staged.files.length });
    const sourceAfter = await inventoryTree(legacyRoot);
    assert(sourceAfter.sourceDigest === sourceBefore.sourceDigest, 'RECOVERY_CAPSULE_SOURCE_CHANGED', 'Legacy source changed while the Recovery Capsule snapshot was being created.', { before: sourceBefore.sourceDigest, after: sourceAfter.sourceDigest });
    const stagedBytes = totalBytes(staged);
    const body = {
      protocolVersion: '1.0',
      capsuleId: id,
      commandId,
      createdAt: now(),
      importer: { id: importer.id, version: importer.version },
      sourceDigest: staged.sourceDigest,
      assessmentDigest: assessment.assessmentDigest,
      fileCount: staged.files.length,
      totalBytes: stagedBytes,
      files: staged.files,
      executableContent: false,
      retention: 'user-controlled',
    };
    const manifest = { ...body, manifestDigest: digestJson(body) };
    assertJsonSchema(manifest, capsuleSchema, { code: 'RECOVERY_CAPSULE_MANIFEST_SCHEMA_INVALID', label: 'Recovery Capsule manifest' });
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
  await assertCapsuleLayout(capsuleRoot);
  const manifest = JSON.parse(await readFile(resolve(capsuleRoot, 'capsule.json'), 'utf8'));
  const assessment = JSON.parse(await readFile(resolve(capsuleRoot, 'assessment.json'), 'utf8'));
  assertJsonSchema(manifest, capsuleSchema, { code: 'RECOVERY_CAPSULE_MANIFEST_SCHEMA_INVALID', label: 'Recovery Capsule manifest' });
  const { manifestDigest, ...body } = manifest;
  assert(manifestDigest === digestJson(body), 'RECOVERY_CAPSULE_MANIFEST_MISMATCH', 'Recovery Capsule manifest digest mismatch.');
  const payloadRoot = resolve(capsuleRoot, 'payload');
  const inventory = await inventoryTree(payloadRoot);
  const forbidden = forbiddenFiles(inventory);
  assert(forbidden.length === 0 && manifest.executableContent === false, 'RECOVERY_CAPSULE_EXECUTABLE_REJECTED', 'Recovery Capsule contains executable source or binary files.', { forbidden });
  assert(manifest.sourceDigest === digestJson(manifest.files), 'RECOVERY_CAPSULE_FILE_MANIFEST_MISMATCH', 'Recovery Capsule manifest file records do not produce the declared source digest.');
  assert(JSON.stringify(inventory.files) === JSON.stringify(manifest.files), 'RECOVERY_CAPSULE_FILE_MANIFEST_MISMATCH', 'Recovery Capsule payload files do not exactly match the manifest.');
  assert(inventory.sourceDigest === manifest.sourceDigest, 'RECOVERY_CAPSULE_SOURCE_MISMATCH', 'Recovery Capsule payload digest mismatch.');
  assert(inventory.files.length === manifest.fileCount, 'RECOVERY_CAPSULE_FILE_COUNT_MISMATCH', 'Recovery Capsule file count mismatch.');
  assert(totalBytes(inventory) === manifest.totalBytes, 'RECOVERY_CAPSULE_TOTAL_BYTES_MISMATCH', 'Recovery Capsule total byte count mismatch.');
  assertAssessment(assessment, { importer: manifest.importer, sourceDigest: manifest.sourceDigest, fileCount: manifest.fileCount });
  assert(assessment.assessmentDigest === manifest.assessmentDigest, 'RECOVERY_CAPSULE_ASSESSMENT_MISMATCH', 'Recovery Capsule assessment does not match the manifest.');
  return { root: capsuleRoot, payloadRoot, manifest, assessment };
};
