import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sha256 } from '../common/canonical.mjs';
import { assertNoLinkPath } from '../common/paths.mjs';

const fileSchema = { type: 'object', required: ['path', 'sha256'], additionalProperties: false,
  properties: { path: { type: 'string', minLength: 1 }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } } };
const questionSchema = { type: 'object', additionalProperties: false,
  required: ['question', 'classification', 'action', 'verification', 'unitsIncluded'], properties: {
    question: { type: 'string', minLength: 1 }, classification: { enum: ['in-scope-work', 'verification-pending', 'external-prerequisite', 'contract-change', 'unresolved'] },
    action: { type: 'string', minLength: 1 }, verification: { type: 'string', minLength: 1 }, unitsIncluded: { type: 'boolean' },
  } };
export const diagnosisSchema = { type: 'object', additionalProperties: false,
  required: ['sourceSubmissionId', 'contractDigest', 'conclusion', 'reason', 'evidence', 'repairPaths', 'remainingWork'],
  properties: { sourceSubmissionId: { type: 'string' }, contractDigest: { type: 'string' },
    conclusion: { enum: ['in-scope', 'contract-change', 'external-prerequisite', 'unresolved'] }, reason: { type: 'string', minLength: 1 },
    evidence: { type: 'array', minItems: 1, maxItems: 32, items: fileSchema },
    observations: { type: 'array', maxItems: 32, items: fileSchema },
    repairPaths: { type: 'array', maxItems: 64, uniqueItems: true, items: { type: 'string', minLength: 1 } },
    remainingWork: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', additionalProperties: false,
      required: ['work', 'existingImplementation', 'remainingDevelopment', 'verification', 'unknowns', 'units'], properties: {
        work: { type: 'string', minLength: 1 }, existingImplementation: { type: 'string', minLength: 1 },
        remainingDevelopment: { type: 'string', minLength: 1 }, verification: { type: 'string', minLength: 1 },
        unknowns: { type: 'array', maxItems: 32, items: { anyOf: [{ type: 'string' }, questionSchema] } },
        units: { type: 'number', minimum: 0 },
      } } },
  } };

const projectPath = path => typeof path === 'string' && !/[\\:*?]/.test(path) && !path.startsWith('/')
  && path.split('/').every(part => part && part !== '.' && part !== '..');
const inScope = (feature, path) => projectPath(path)
  && feature.allowedPaths.some(root => path === root || path.startsWith(`${root}/`))
  && !feature.forbiddenPaths.some(root => path === root || path.startsWith(`${root}/`));

/** Model recommendation defects are feedback, never evidence of lost Authority. */
export const assessDiagnosis = async ({ value, parent, snapshot, workspaceRoot, evidenceStore, evidenceContext }) => {
  const issues = [], observations = [], boundaries = [];
  for (const item of value.evidence) {
    if (!snapshot.files.some(file => file.path === item.path && file.sha256 === item.sha256)) {
      issues.push({ code: 'SOURCE_EVIDENCE_REQUIRED', path: item.path,
        instruction: 'Use evidence only for exact current source inventory members. Historical logs may be observations; they grant no acceptance credit.' });
    }
  }
  // Observations are separately sealed current readings, not authoritative source
  // or proof that an earlier invocation passed. Never recursively scan outputs.
  for (const item of value.observations ?? []) {
    let bytes;
    try {
      if (!projectPath(item.path)) throw new Error('A canonical project-relative path is required.');
      const path = assertNoLinkPath(workspaceRoot, resolve(workspaceRoot, item.path));
      const info = await stat(path);
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Observation must be a regular file of at most 1 MiB.');
      bytes = await readFile(path);
      if (bytes.length > 1024 * 1024 || sha256(bytes) !== item.sha256) throw new Error('Observation bytes do not match.');
    } catch {
      issues.push({ code: 'OBSERVATION_INVALID', path: item.path, instruction: 'Read and hash an exact bounded, unlinked project file, or omit this non-authoritative observation.' });
      continue;
    }
    const stored = await evidenceStore.put(bytes, { ...evidenceContext, mediaType: 'application/octet-stream',
      labels: ['diagnostic-observation'], observedPath: item.path, acceptanceCredit: false });
    observations.push({ ...item, evidenceRef: stored.ref, acceptanceCredit: false });
  }
  for (const path of value.repairPaths) if (!inScope(parent, path)) issues.push({ code: 'REPAIR_SCOPE_EXPANSION', path,
    instruction: 'Retain original write authority; classify a necessary scope change as contract-change instead of granting it.' });
  for (const [index, work] of value.remainingWork.entries()) for (const question of work.unknowns) {
    if (typeof question === 'string' || !question.unitsIncluded) issues.push({ code: 'QUESTION_DISPOSITION_REQUIRED', workIndex: index,
      instruction: 'Classify each question. Ordinary work or pending verification requires a concrete in-scope action, retained verification and cost already included in this work estimate. Do not relabel unresolved authorization or prerequisites as ordinary work.' });
    else if (!['in-scope-work', 'verification-pending'].includes(question.classification)) boundaries.push({ workIndex: index, ...question });
  }
  const capacity = parent.metadata?.deliveryBatch?.sizing?.capacityUnits;
  const units = value.remainingWork.reduce((sum, work) => sum + work.units, 0);
  if (Number.isFinite(capacity) && units > capacity) boundaries.push({ classification: 'capacity', units, capacity });
  return { disposition: issues.length ? 'correction-required' : value.conclusion !== 'in-scope' || boundaries.length ? 'blocked' : 'accepted',
    issues, boundaries, observations, remainingUnits: units, capacity: capacity ?? null };
};
