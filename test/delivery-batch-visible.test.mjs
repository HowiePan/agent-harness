import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadExtensionPack, harnessTemporaryRoot } from '../src/index.mjs';
import { createTestHarness as createHarness } from './lifecycle-command-support.mjs';
import { createDeliveryProjectDescriptor } from '../src/flows/delivery-lifecycle/descriptor.mjs';
import { projectExecutionPolicyDecisionContext } from '../src/platform/registry/project-registry.mjs';
import { planApprovalSnapshot } from '../src/flows/delivery-lifecycle/plan-approval.mjs';
import { createMockVisibleHostAdapter } from './test-support.mjs';
import { proposal, completion } from './delivery-batch-support.mjs';
import { sha256 } from '../src/common/canonical.mjs';

for (const mode of ['ordinary', 'input', 'capacity', 'unknown', 'clarification', 'clarification-exhausted-resume', 'contract', 'over-capacity','registration-interruption','ack-interruption','user-stopped-resume','user-stopped-active-resume','compound-recovery']) test(`native-visible bounded deliveries: ${mode}, with genuine checks and no Agent CLI`, async t => {
  const repairInput = mode === 'input';
  const resumeBoundary = mode === 'clarification-exhausted-resume';
  const clarificationMode = mode.startsWith('clarification');
  const reviewMode = ['capacity', 'unknown', 'contract', 'over-capacity'].includes(mode) || clarificationMode;
  const expectedStop = ['contract', 'over-capacity'].includes(mode) || resumeBoundary;
  const controlRoot = resolve(process.cwd());
  const root = await mkdtemp(resolve(harnessTemporaryRoot(), 'bounded-visible-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = resolve(root, 'project');
  await mkdir(resolve(workspaceRoot, '.git'), { recursive: true });
  await mkdir(resolve(workspaceRoot, 'src'));
  await writeFile(resolve(workspaceRoot, 'src/receiver.mjs'), 'export const receive = x => x * 3;');
  await writeFile(resolve(workspaceRoot, 'historical.log'), 'Unaccepted historical evidence.');
  await writeFile(resolve(workspaceRoot, 'verify.mjs'), "import assert from 'node:assert/strict'; import {receive} from './src/receiver.mjs'; assert.equal(receive(4),8);");
  const approvedProposal = proposal();
  if (resumeBoundary) approvedProposal.deliveryBatchReserve = 1;
  if (repairInput) {
    await mkdir(resolve(workspaceRoot, 'src/tests/suites'), { recursive: true });
    await writeFile(resolve(workspaceRoot, 'src/Cargo.toml'), '[[test]]\nname="receiver"\npath="tests/suites/receiver.rs"\n');
    await writeFile(resolve(workspaceRoot, 'src/tests/suites/receiver.rs'), 'receiver test source');
    const check = approvedProposal.deliveryBatches[0].checks[0];
    check.command.push('--test', 'receiver');
    check.inputs.push('src/Cargo.toml', 'src/tests/receiver.rs');
  }
  const extension = await loadExtensionPack('./src/flows/delivery-lifecycle/index.mjs', { controlRoot });
  const runtime = await loadExtensionPack('./integrations/codex/extensions/codex-runtime.mjs', { controlRoot });
  const packets = new Map(); const spawned = [];
  let confirmationInterrupted=false,stoppedContained=0,resultInterrupted=false,dispatchInterrupted=false;
  const adapter = createMockVisibleHostAdapter({ onSpawn: input => {
    const bytes = readFileSync(`${input.packet.outputRef}.dispatch-packet.json`);
    assert.equal(sha256(bytes), input.packetDigest);
    assert.deepEqual(JSON.parse(bytes), input.packet);
    packets.set(input.dispatchId, input.packet); spawned.push(input.packet);
  },
    onConfirm:input=>{
      if(mode==='user-stopped-active-resume'&&packets.get(input.dispatchId)?.feature.metadata.deliveryBatch&&!confirmationInterrupted){
        confirmationInterrupted=true;throw Object.assign(Error('fixture stopped after bound Lease'),{code:'SIMULATED_CONFIRMATION_FAILURE'});
      }
      return {confirmed:true};
    },
    onContain:input=>{assert(packets.has(input.dispatchId));stoppedContained++;
      return {contained:true,outcome:{disposition:'already-terminal',reason:input.reason,observationRequestDigest:'a'.repeat(64)}};},
    onResult: async input => {
      if(mode==='compound-recovery'&&packets.get(input.dispatchId)?.feature.metadata.deliveryBatch&&!resultInterrupted){resultInterrupted=true;throw Object.assign(Error('temporary result read failure'),{code:'NEW_UNREGISTERED_RESULT_ERROR'});}
      const packet = packets.get(input.dispatchId); const feature = packet.feature;
      const output = (port, schemaId, value) => ({ status: 'completed', summary: 'Observed fixture result.', changedFiles: [],
        outputs: { [port]: { schemaId, value, evidenceRefs: ['fixture:inspection'] } } });
      if (feature.metadata.stage === 'version-planning') return output('plan', 'delivery-plan-v1', { features: ['F01'], proposedFeatures: [approvedProposal] });
      if (feature.metadata.stage === 'plan-review') return output('plan-review', 'delivery-plan-review-v1', { approved: true, findings: [] });
      if (feature.kind === 'execution-diagnostic' && feature.metadata.intervention.subject.deliveryBatch?.id === 'receiver') {
        assert.deepEqual(feature.allowedPaths, []);
        const spec = feature.metadata.intervention;
        const log = { path: 'historical.log', sha256: sha256(await readFile(resolve(workspaceRoot, 'historical.log'))) };
        return output('diagnosis', 'execution-diagnosis-v1', {
          sourceSubmissionId: spec.sourceSubmissionId, contractDigest: spec.contractDigest,
          conclusion: mode === 'contract' ? 'contract-change' : 'in-scope',
          reason: 'Source inspection separates existing receiver from the remaining implementation and verification.',
          evidence: [{ path: 'src/receiver.mjs', sha256: sha256(await readFile(resolve(workspaceRoot, 'src/receiver.mjs'))) },
            ...(clarificationMode && !spec.correctionOf ? [log] : [])],
          ...(clarificationMode && spec.correctionOf ? { observations: [log] } : {}),
          repairPaths: ['src/receiver.mjs'], remainingWork: [{ work: 'Receiver behavior', existingImplementation: 'Receiver module exists.',
            remainingDevelopment: 'Fix its multiplication.', verification: 'All original behavior checks.',
            unknowns: !clarificationMode ? [] : !spec.correctionOf ? ['All original checks remain pending.'] : [{ question: 'All original checks remain pending.',
              classification: 'verification-pending', action: 'Run all declared checks after the fix.', verification: 'The entire original behavior check.', unitsIncluded: true }],
            units: mode === 'over-capacity' ? 9 : 2 }],
        });
      }
      if (feature.metadata.deliveryBatch?.id === 'receiver') {
        if (reviewMode && spawned.filter(item => item.feature.id === feature.id).length === 1) return {
          status: 'blocked', summary: mode === 'unknown' ? 'A newly named issue needs diagnosis.' : 'Worker claims estimate exceeds capacity.', changedFiles: [],
          failureClass: mode === 'unknown' ? 'previously-unseen-problem' : 'capacity-mismatch',
          blocker: { kind: mode === 'unknown' ? 'unknown-new-problem' : 'capacity', summary: 'Worker conclusion requires independent source review.' } };
        if (repairInput && spawned.filter(item => item.feature.id === feature.id).length === 1) return {
          status: 'blocked', summary: 'Observed missing conventional test input; explicit manifest target exists.', changedFiles: [],
          failureClass: 'external-blocker', blocker: { kind: 'prerequisite', code: 'delivery-check-input-rebinding-required',
            summary: 'Manifest-declared test source needs Host input binding.' } };
        await writeFile(resolve(workspaceRoot, 'src/receiver.mjs'), 'export const receive = x => x * 2;');
        return completion(feature, ['src/receiver.mjs']);
      }
      if (feature.metadata.deliveryBatch) return completion(feature);
      return { status: 'blocked', summary: 'Fixture intentionally stops after original Feature convergence.', changedFiles: [],
        failureClass: 'external', blocker: { kind: 'external', summary: 'Fixture scope handoff.' } };
    }, onReconcile: async () => ({ ready: true, provider: 'test-host', adapterVersion: '1.0.0',
      contract: { id: 'delivery-batch-test-native', version: '1.0.0', digest: 'd'.repeat(64) },
      assertionId: 'delivery-native-fixture', observedAt: new Date().toISOString(), reconciled: [], issues: [] }) });
  const harness = await createHarness({ controlRoot, dataRoot: resolve(root, 'data'), strictProjectIdentity: false,
    releaseIdentity: { version: '1.0.0', artifactDigest: 'a'.repeat(64), verified: true }, extensions: [extension, runtime], agentAdapter: adapter });
  const descriptor = createDeliveryProjectDescriptor({ id: 'project', workspaceRoot, gateRecipes: [],
    actionPaths: { plan: ['docs'], implement: ['src', 'verify.mjs'], scope: ['docs'] } });
  descriptor.policy.deliveryBatchPolicy = 'bounded-delivery/2';
  descriptor.extensions.find(item => item.id === extension.id).digest = extension.digest;
  descriptor.extensions.find(item => item.id === runtime.id).digest = runtime.digest;
  descriptor.workflows = extension.workflows.map(item => ({ id: item.id, version: item.version,
    artifactDigest: item.artifactDigest, extensionId: extension.id }));
  await harness.projectRegistry.register(descriptor, { commandId: 'register-visible-fixture', authorityDecision: {
    actor: 'test', decision: 'approved', action: 'project-execution-policy-change', expiresAt: '2099-01-01T00:00:00.000Z',
    context: projectExecutionPolicyDecisionContext({ input: descriptor }) } });
  let injectedRegistrationInterruption=false;
  const execute = async action => {
    const plan = await harness.createLifecyclePlan({ projectId: descriptor.id, action, target: 'V1.0.0', extensionId: extension.id, executionWorkspaceRoot: workspaceRoot });
    return harness.withUserLifecycleCommand({commandId:`fixture-${action}`,scope:{projectId:descriptor.id,action,target:'V1.0.0',workspaceRoot}},async()=>{
    const preflightReport = await harness.createExecutionReadinessReport(plan);
    assert.equal(preflightReport.executionReady, true, JSON.stringify(preflightReport));
    return harness.executeVisibleLifecyclePlan(plan, { commandId: `fixture-${action}`, preflightReport, maxConcurrency: 1,
      onGateProgress:event=>{
        const stage=mode==='registration-interruption'?'verified':mode==='ack-interruption'?'authority-committed':null;
        if(action==='implement'&&stage&&event.phase==='result-registration'&&event.stage===stage&&!injectedRegistrationInterruption){
          injectedRegistrationInterruption=true;throw Error('controlled native-visible registration interruption');
        }
      } });
    });
  };
  const planned = await execute('plan');
  assert.equal(planned.reason, 'implementation-plan-user-approval-required');
  const snapshot = planApprovalSnapshot(planned.state);
  const approved = await harness.kernel.recordDecision(descriptor.id, planned.state.runId, {
    id: 'implementation-plan-approved', actor: 'user', decision: 'approved', projectId: descriptor.id,
    runId: planned.state.runId, planDigest: snapshot.planDigest, artifactDigest: snapshot.artifactDigest },
  { expectedRevision: planned.state.revision, commandId: 'fixture-approval' });
  await harness.kernel.closeRun(descriptor.id, approved.state.runId, {}, { expectedRevision: approved.state.revision, commandId: 'fixture-close-plan' });
  if(mode==='compound-recovery'){
    const dispatch=harness.dispatch;
    harness.dispatch=async(...args)=>{
      const result=await dispatch(...args);
      if(!dispatchInterrupted){dispatchInterrupted=true;throw Object.assign(Error('lost scheduling acknowledgement'),{code:'NEW_UNREGISTERED_ACK_ERROR'});}
      return result;
    };
  }
  let implemented;
  if(mode.startsWith('user-stopped-')){
    const plan=await harness.createLifecyclePlan({projectId:descriptor.id,action:'implement',target:'V1.0.0',extensionId:extension.id,executionWorkspaceRoot:workspaceRoot});
    const scope={projectId:descriptor.id,action:'implement',target:'V1.0.0',workspaceRoot};
    let started;
    if(mode==='user-stopped-active-resume'){
      await assert.rejects(execute('implement'),{code:'SIMULATED_CONFIRMATION_FAILURE'});
      started={state:await harness.authorityStore.read(descriptor.id,plan.run.runId)};
      assert.equal(started.state.leases.filter(l=>l.status==='active').length,1);
    }else started=await harness.withUserLifecycleCommand({commandId:'fixture-before-stop',scope},async()=>{
      const preflightReport=await harness.createExecutionReadinessReport(plan);
      return harness.startLifecyclePlan(plan,{commandId:'fixture-before-stop',preflightReport});
    });
    const stopped=(await harness.kernel.recordDecision(descriptor.id,started.state.runId,{id:'fixture-user-stop',actor:'human-user',decision:'approved',action:'stop-execution',
      context:{projectId:descriptor.id,runId:started.state.runId,sourceDigest:started.state.sourceDigest,priorAuthorityDigest:started.state.authorityDigest}},
    {commandId:'fixture-user-stop',expectedRevision:started.state.revision})).state;
    const attemptsBefore=JSON.stringify(stopped.attempts);
    implemented=await harness.withUserLifecycleCommand({commandId:'fixture-user-restart',scope,userIssuedAt:new Date().toISOString()},async()=>{
      let prepared=stopped;
      if(mode==='user-stopped-active-resume'){
        prepared=await harness.prepareUserRequestedRestart({projectId:descriptor.id,runId:stopped.runId});
        assert.equal(prepared.metadata.operatorStop.requested,true);assert.equal(prepared.leases.filter(l=>l.status==='active').length,0);
        assert.equal(prepared.sourceDigest,stopped.sourceDigest);assert.equal(stoppedContained,1);
      }
      const resume=await harness.createLifecycleResumePlan({projectId:descriptor.id,runId:stopped.runId,executionWorkspaceRoot:workspaceRoot});
      const unchanged=await harness.authorityStore.read(descriptor.id,stopped.runId);
      assert.equal(unchanged.authorityDigest,prepared.authorityDigest,'Planning cannot remove the stop');
      assert.equal(JSON.stringify(unchanged.attempts),attemptsBefore);
      const preflightReport=await harness.createExecutionReadinessReport(resume.plan);
      assert.equal(preflightReport.executionReady,true);
      return harness.executeVisibleLifecyclePlan(resume.plan,{commandId:'fixture-user-restart',preflightReport,resume,onGateProgress:()=>{}});
    });
    const decision=implemented.state.decisions.find(d=>d.action==='resume-execution');assert(decision);
    assert.equal(decision.context.commandId,'fixture-user-restart');assert.equal(decision.context.priorStopDecisionId,'fixture-user-stop');
    assert.equal(implemented.state.metadata.operatorStop.requested,false);
  }else if (resumeBoundary) {
    const apply = harness.applyInterruptionReview;
    let processLoss = true;
    harness.applyInterruptionReview = async (...args) => {
      if (processLoss) { processLoss = false; throw new Error('simulated process loss before diagnostic assessment'); }
      return apply(...args);
    };
    // An ordinary thrown exception is not process loss: recover it inside the same command.
    implemented = await execute('implement');
    assert(implemented.state.decisions.some(d=>d.recovery?.operation==='application.applyInterruptionReview'&&d.recovery.status==='recovered'));
    assert.equal(implemented.interruption.category, 'recovery-budget');
    assert.equal(implemented.coordination.userInputRequired, true);
  } else implemented = await execute('implement');
  if(mode==='compound-recovery'){
    assert(dispatchInterrupted&&resultInterrupted);
    const recovery=implemented.state.decisions.filter(d=>d.kind==='execution-action-recovery');
    assert(recovery.some(d=>d.recovery.operation==='application.dispatch'&&d.recovery.action==='reconcile'));
    assert(recovery.some(d=>d.recovery.operation==='host.result'&&d.recovery.status==='recovered'));
    assert((await harness.authorityStore.list(descriptor.id)).filter(s=>s.metadata.commandIntent?.action==='implement').length===1);
  }
  if(['registration-interruption','ack-interruption'].includes(mode))assert(injectedRegistrationInterruption);
  const deliveries = spawned.filter(packet => packet.feature.metadata.deliveryBatch);
  assert.equal(deliveries.length, expectedStop ? 1 : repairInput || reviewMode || mode==='user-stopped-active-resume' ? 3 : 2,
    JSON.stringify({ reason: implemented.reason, interruption: implemented.interruption,
      features: implemented.state.features.map(item => ({ id: item.id, state: item.state, dependsOn: item.dependsOn })),
      attempts: implemented.state.attempts }));
  if (!expectedStop) assert.notEqual(deliveries[0].dispatchId, deliveries[1].dispatchId);
  assert(deliveries.every(packet => packet.execution.runtime.mode === 'conversation-visible'));
  assert.equal(implemented.state.features.filter(feature => feature.metadata.deliveryBatch).every(feature => feature.state === 'completed'), !expectedStop);
  assert.equal(implemented.state.features.find(feature => feature.metadata.stage === 'scope-resolution').state, expectedStop ? 'pending' : 'blocked');
  assert.equal(implemented.interruption.action, 'stop');
  assert(implemented.interruption.evidenceRef);
  if (reviewMode) {
    const diagnostic = spawned.find(item => item.feature.metadata.intervention?.subject.deliveryBatch?.id === 'receiver');
    assert(diagnostic);
    assert.equal(implemented.state.metadata.interruptionLedger.filter(item => item.logicalRoot === deliveries[0].feature.logicalRoot).length, mode === 'clarification' ? 2 : 1);
    assert.deepEqual(implemented.state.features.find(item => item.id === deliveries[0].feature.id).metadata.deliveryBatch.checks, approvedProposal.deliveryBatches[0].checks);
    if (!expectedStop) assert(deliveries[1].execution.implementationContinuation.interruptionResolution);
    else assert.equal(implemented.state.features.find(item => item.id === deliveries[0].feature.id).state, 'blocked');
  }
  if (repairInput) {
    assert.equal(implemented.state.decisions.filter(item => item.kind === 'verification-input-repair').length, 1);
    assert.equal(deliveries[1].execution.implementationContinuation.workBatch.verificationInputBindings[0].bindings.length, 1);
    assert.deepEqual(implemented.state.features.find(feature => feature.id === deliveries[1].feature.id).metadata.deliveryBatch.checks,
      approvedProposal.deliveryBatches[0].checks);
  }
});
