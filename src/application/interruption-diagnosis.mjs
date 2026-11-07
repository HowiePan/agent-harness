import { readFile, stat } from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import { resolve } from 'node:path';
import { sha256 } from '../common/canonical.mjs';
import { assertNoLinkPath } from '../common/paths.mjs';
import { assertFeatureFileAccess } from '../common/project-file-policy.mjs';
import { assessInputDiscovery, resolutionActionSchema, projectInputPathPermitted } from './diagnostic-input-discovery.mjs';

const fileSchema = { type: 'object', required: ['path', 'sha256'], additionalProperties: false,
  properties: { path: { type: 'string', minLength: 1 }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } } };
const questionSchema = { type: 'object', additionalProperties: false,
  required: ['question', 'classification', 'action', 'verification', 'unitsIncluded'], properties: {
    question: { type: 'string', minLength: 1 }, classification: { enum: ['in-scope-work', 'verification-pending', 'external-prerequisite', 'contract-change', 'unresolved'] },
    action: { type: 'string', minLength: 1 }, verification: { type: 'string', minLength: 1 }, unitsIncluded: { type: 'boolean' },
    actionId: { type: 'string', minLength: 1 },
  } };
export const diagnosisSchema = { type: 'object', additionalProperties: false,
  required: ['sourceSubmissionId', 'contractDigest', 'conclusion', 'reason', 'evidence', 'repairPaths', 'remainingWork'],
  properties: { sourceSubmissionId: { type: 'string' }, contractDigest: { type: 'string' },
    conclusion: { enum: ['in-scope', 'contract-change', 'external-prerequisite', 'unresolved'] }, reason: { type: 'string', minLength: 1 },
    evidence: { type: 'array', minItems: 1, maxItems: 32, items: fileSchema },
    observations: { type: 'array', maxItems: 32, items: fileSchema },
    repairPaths: { type: 'array', maxItems: 64, uniqueItems: true, items: { type: 'string', minLength: 1 } },
    resolutionActions: { type: 'array', minItems: 1, maxItems: 16, items: resolutionActionSchema },
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
export const assessDiagnosis = async ({ value, parent, snapshot, workspaceRoot, evidenceStore, evidenceContext, projectFilePolicy = null }) => {
  const issues = [], observations = [], boundaries = [];
  const inputDiscoveries = [];
  const inputAdmissions = [];
  const actionIds = new Set();
  for (const action of value.resolutionActions ?? []) {
    if (actionIds.has(action.id)) issues.push({code:'DUPLICATE_RESOLUTION_ACTION',actionId:action.id});
    actionIds.add(action.id);
    if (!['input-discovery','input-admission'].includes(action.kind)) boundaries.push({classification:action.kind,actionId:action.id,summary:action.summary});
    if(action.kind==='input-admission'){
      const a=action.admission;
      const work=value.remainingWork.filter(w=>w.unknowns.some(q=>q.actionId===action.id));
      let valid=Boolean(projectFilePolicy&&a?.candidates?.length&&a.work&&a.verification&&action.paths.length
        &&work.length&&work.every(w=>w.unknowns.filter(q=>q.actionId===action.id).every(q=>q.unitsIncluded))
        &&a.candidates.every(c=>projectInputPathPermitted(c.path,projectFilePolicy)&&snapshot.files.some(f=>f.path===c.path&&f.sha256===c.sha256)
          &&value.evidence.some(e=>e.path===c.path&&e.sha256===c.sha256)));
      try{for(const path of action.paths)assertFeatureFileAccess({feature:parent,policy:projectFilePolicy,path,workspaceRoot});}
      catch{valid=false;}
      if(!valid)issues.push({code:'INPUT_ADMISSION_INVALID',actionId:action.id,instruction:'Bind real source candidates, project-owned work paths, included work cost and original verification; admission is implementation work, never certified historical evidence.'});
      else inputAdmissions.push({actionId:action.id,status:'preparation-required',paths:action.paths,...a,completionCredit:false});
    }
    if (action.kind === 'input-discovery') {
      const result = await assessInputDiscovery({action,snapshot,workspaceRoot,projectFilePolicy});
      if (result.issue) issues.push(result.issue);
      else {inputDiscoveries.push(result.discovery);
        if(result.discovery.status!=='found')boundaries.push({classification:'input-discovery',actionId:action.id,status:result.discovery.status});}
    }
  }
  for (const item of value.evidence) {
    if (!snapshot.files.some(file => file.path === item.path && file.sha256 === item.sha256)) {
      issues.push({ code: 'SOURCE_EVIDENCE_REQUIRED', path: item.path,
        instruction: 'Use evidence only for exact current source inventory members. Historical logs may be observations; they grant no acceptance credit.' });
    }
  }
  // Observations are separately sealed current readings, not authoritative source
  // or proof that an earlier invocation passed. Never recursively scan outputs.
  for (const item of value.observations ?? []) {
    let bytes,streamed=null;
    try {
      if (!projectPath(item.path)) throw new Error('A canonical project-relative path is required.');
      if(projectFilePolicy&&!projectInputPathPermitted(item.path,projectFilePolicy))throw new Error('Observation outside project ownership.');
      const path = assertNoLinkPath(workspaceRoot, resolve(workspaceRoot, item.path));
      const info = await stat(path);
      if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('Observation must be a bounded regular project file.');
      if(info.size>1024*1024){
        const hash=createHash('sha256');let size=0;
        for await(const chunk of createReadStream(path,{highWaterMark:65536})){
          size+=chunk.length;if(size>32*1024*1024)throw new Error('Observation exceeds shard.');hash.update(chunk);
        }
        const after=await stat(path);
        if(hash.digest('hex')!==item.sha256||size!==info.size||after.mtimeMs!==info.mtimeMs)throw new Error('Observation drift.');
        streamed={...item,size,storage:'digest-observation',acceptanceCredit:false};
      }else{bytes = await readFile(path);
        if(bytes.length>1024*1024||sha256(bytes)!==item.sha256)throw new Error('Observation bytes do not match.');}
    } catch {
      issues.push({ code: 'OBSERVATION_INVALID', path: item.path, instruction: 'Read and hash an exact bounded, unlinked project file, or omit this non-authoritative observation.' });
      continue;
    }
    const stored = await evidenceStore.put(streamed??bytes, { ...evidenceContext, mediaType: streamed?'application/json':'application/octet-stream',
      labels: ['diagnostic-observation'], observedPath: item.path, acceptanceCredit: false });
    observations.push({ ...item,...(streamed?{size:streamed.size,storage:streamed.storage}:{}), evidenceRef: stored.ref, acceptanceCredit: false });
  }
  for (const path of value.repairPaths) {
    let permitted = inScope(parent, path);
    if (projectFilePolicy) {
      try { assertFeatureFileAccess({ feature: parent, policy: projectFilePolicy, path, workspaceRoot }); permitted = true; }
      catch { permitted = false; }
    }
    if (!permitted) issues.push({ code: 'REPAIR_SCOPE_EXPANSION', path,
      instruction: 'Repair only within project-owned roots and retained acceptance; external writes require explicit authority.' });
  }
  for (const [index, work] of value.remainingWork.entries()) for (const question of work.unknowns) {
    if (typeof question === 'string' || ['in-scope-work', 'verification-pending'].includes(question.classification) && !question.unitsIncluded) issues.push({ code: 'QUESTION_DISPOSITION_REQUIRED', workIndex: index,
      instruction: 'Classify each question. Ordinary work or pending verification requires a concrete in-scope action, retained verification and cost already included in this work estimate. Do not relabel unresolved authorization or prerequisites as ordinary work.' });
    else if (!['in-scope-work', 'verification-pending'].includes(question.classification)
      && !(question.classification === 'external-prerequisite' && (inputDiscoveries.some(d=>d.actionId===question.actionId&&d.status==='found')
        ||inputAdmissions.some(d=>d.actionId===question.actionId)))) boundaries.push({ workIndex: index, ...question });
  }
  const capacity = parent.metadata?.deliveryBatch?.sizing?.capacityUnits;
  const units = value.remainingWork.reduce((sum, work) => sum + work.units, 0);
  if (Number.isFinite(capacity) && units > capacity) boundaries.push({ classification: 'capacity', units, capacity });
  const resolvedExternal = value.conclusion === 'external-prerequisite' && (inputDiscoveries.some(d=>d.status==='found')||inputAdmissions.length>0) && !boundaries.length
    && value.remainingWork.some(w=>w.unknowns.some(q=>typeof q==='object'&&q.classification==='external-prerequisite'&&q.actionId));
  return { disposition: issues.length ? 'correction-required' : value.conclusion !== 'in-scope' && !resolvedExternal || boundaries.length ? 'blocked' : 'accepted',
    issues, boundaries, observations, remainingUnits: units, capacity: capacity ?? null,
    ...(inputDiscoveries.length ? {inputDiscoveries} : {}),...(inputAdmissions.length?{inputAdmissions}:{}),
    ...(inputAdmissions.length?{continuationPurpose:'prepare-and-verify-existing-inputs',acceptanceCredit:false}: {}) };
};
