import assert from 'node:assert/strict';
import { canonicalize, digestJson } from '../src/common/canonical.mjs';
export const evidenceFixture = () => {
  const original = {status:'completed',summary:'Unaccepted native draft.',changedFiles:['src/receiver.mjs']};
  const snapshot = {files:[],digest:digestJson([])};
  const terminal = {dispatchId:'dispatch',evidenceRef:'evidence:pinned',resultDigest:digestJson(original),hostReceiptDigest:'host'};
  const prior = {projectId:'project',runId:'retired',status:'failed',epoch:1,generation:1,sourceDigest:'source',
    artifactDigest:'artifact',policyDigest:'policy',pluginSetDigest:'plugins',
    metadata:{unacceptedTerminalResult:terminal},submissions:[],
    features:[{id:'old-feature',logicalRoot:'owner'}],dispatches:[{dispatchId:'dispatch',featureId:'old-feature',status:'superseded'}]};
  const record={kind:'unaccepted-terminal-result-retirement',version:'1.0',originalResult:original,originalResultDigest:digestJson(original),
    hostObservationReceipt:{receiptDigest:'host'},sourceDelta:{observedSnapshot:snapshot,observedSourceDigest:snapshot.digest,claimedChangedFiles:original.changedFiles}};
  const evidence={bytes:Buffer.from(canonicalize(record)),metadata:{projectId:'project',runId:'retired',epoch:1,generation:1,
    featureId:'old-feature',dispatchId:'dispatch',sourceDigest:'source',artifactDigest:'artifact',policyDigest:'policy',pluginSetDigest:'plugins'}};
  const plan={projectId:'project',runId:'plan',metadata:{planRevision:{implementationBaselines:[{runId:'retired'}]}}};
  const nodes={plan,retired:prior};
  return {state:{projectId:'project',runId:'current',metadata:{approvedPlan:{runId:'plan'}}},
    feature:{logicalRoot:'owner',metadata:{deliveryBatch:{}}},
    authorityStore:{read:async(project,id)=>{assert.equal(project,'project');assert(nodes[id],`undeclared ancestry ${id}`);return nodes[id];}},
    evidenceStore:{read:async ref=>{assert.equal(ref,'evidence:pinned');return evidence;}},nodes,evidence,record};
};

