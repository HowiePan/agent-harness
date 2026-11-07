import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFileBoundary, applyConfiguredFileBoundary } from '../src/common/configured-file-boundary.mjs';
import {validateProjectHarnessConfig,loadProjectHarnessConfig} from '../src/application/project-initialization.mjs';
const boundary={version:'project-boundary/1',sourceRoots:['engine'],sharedPaths:['scripts/engine.ps1'],artifactRoots:['.local'],protectedPaths:['engine/secrets']};
test('explicit configuration produces only the owned roots and artifact allowance',()=>{
 const draft={policy:{projectFilePolicy:{roots:['unsafe-parent']},qualityVerificationOutputs:['wrong']}};
 const result=applyConfiguredFileBoundary(draft,boundary);
 assert.deepEqual(result.policy.projectFilePolicy.roots,['engine','scripts/engine.ps1']);
 assert.deepEqual(result.policy.qualityVerificationOutputs,['.local']);
 result.policy.projectFilePolicy.roots.push('other');assert.deepEqual(boundary.sourceRoots,['engine']);
 assert.equal(applyConfiguredFileBoundary(draft,null),draft);
});
test('missing, escaping, ambiguous or conflicting boundaries are rejected',()=>{
 assert.throws(()=>validateFileBoundary(null));
 for(const sourceRoots of [[],['.'],['../other'],['F:/parent'],['engine/*'],['engine','engine']])assert.throws(()=>validateFileBoundary({...boundary,sourceRoots}));
 assert.throws(()=>validateFileBoundary({...boundary,artifactRoots:['engine/cache']}));
});
test('current project configuration names .cardworld-local explicitly',async()=>{
 const loaded=await loadProjectHarnessConfig('F:/CardWorld/harness.json');
 assert.equal(loaded.config.schemaVersion,'1.2');
 assert.equal(loaded.request.project.executionPolicy.version,'continuous-execution/1');
 assert.deepEqual(loaded.request.project.fileBoundary.artifactRoots,['.cardworld-local']);
 const missing=structuredClone(loaded.config);delete missing.project.fileBoundary;
 assert.throws(()=>validateProjectHarnessConfig(missing),{code:'PROJECT_BOUNDARY_REQUIRED'});
});
