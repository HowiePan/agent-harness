#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHarness, defaultDataRoot } from '../../application/harness.mjs';
import { applyBootstrapPlan, createBootstrapPlan } from '../../application/bootstrap.mjs';
import { newId } from '../../common/canonical.mjs';
import { safeSegment } from '../../common/paths.mjs';
import { ProjectGateRunner } from '../../platform/workflow/gates/project-gate-runner.mjs';
import { loadExtensionPack } from '../../platform/extensions/contract.mjs';
import { ExtensionRegistry } from '../../platform/extensions/registry.mjs';
import { initializeHarnessInstallation } from '../../application/installation.mjs';
import { loadReleaseIdentity } from '../../application/release-identity.mjs';
import { ProjectRegistry } from '../../platform/registry/project-registry.mjs';
import { WorkspaceRegistry } from '../../platform/workspace/workspace-registry.mjs';
import { inspectLifecycleReadiness, readRunStatus } from '../../application/readiness.mjs';
import { assertHarnessWritePath, harnessControlRoot, harnessProjectRoot } from '../../common/write-boundary.mjs';
import { verifyDefectBundle } from '../../platform/maintenance/defect-bundle.mjs';
import { recordIssueIntake } from '../../platform/maintenance/issue-intake.mjs';
import { handleWorkspaceCommand } from './commands/workspace.mjs';
import { handleSourceCommand } from './commands/source.mjs';
import { handleMemoryCommand } from './commands/memory.mjs';
import { AuthorityStore } from '../../kernel/authority-store.mjs';
import { listIssueRecords, readIssueTriage, recordIssueTriage } from '../../platform/maintenance/issue-triage.mjs';
import { applyReleaseActivationPlan, createReleaseActivationPlan } from '../../platform/maintenance/release-activation.mjs';

const argv = process.argv.slice(2);
const take = name => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const has = name => argv.includes(name);
const takeAll = name => argv.flatMap((value, index) => value === name && argv[index + 1] ? String(argv[index + 1]).split(',') : []).filter(Boolean);
const optionalNumber = name => {
  const value = take(name);
  return value === undefined ? undefined : Number(value);
};
const jsonFile = async name => JSON.parse(await readFile(resolve(name), 'utf8'));
const jsonInput = async name => {
  const source = take(name);
  if (!source) throw Object.assign(new Error(`Missing ${name}`), { code: 'INPUT_REQUIRED' });
  if (source !== '-') return jsonFile(source);
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return JSON.parse(raw);
};
const preflightInput = async () => {
  const source = take('--preflight');
  if (!source) throw Object.assign(new Error('Missing --preflight'), { code: 'INPUT_REQUIRED' });
  const input = await jsonFile(source);
  return input.report ?? input;
};
const progressWriter = event => process.stderr.write(`${JSON.stringify({ type: 'agent-harness.progress', ...event })}\n`);
const command = argv[0] ?? 'help';
const subject = argv[1];

const help = () => console.log(`Agent Harness V1.0.0

Global options: [--control-root <path>] [--data-root <path>] [--memory-root <path>] [--extension <module>]... [--harness-digest <sha256>]

agent-harness installation init --control-root <standalone-path>
agent-harness doctor [--control-root <path>] [--data-root <path>]
agent-harness extension register --module <module> --expected-revision <n> --command-id <id> --decision <json>
agent-harness extension list
agent-harness extension remove --id <id> --expected-revision <n> --command-id <id> --decision <json>
agent-harness project register --descriptor <json>
agent-harness project register --id <id> --workspace <absolute-path> --profiles <id,id> --agent-execution-mode <conversation-visible|headless> --runtime <plugin-id>
agent-harness project descriptor --extension <module> --input <json>
agent-harness project list
agent-harness workspace register --input <json|-> --expected-revision <n> --command-id <id> --decision <json>
agent-harness workspace list|show [--workspace-id <id>]
agent-harness workspace rollback --workspace-id <id> --revision <n> --command-id <id> --decision <json>
agent-harness workflow list --project <id>
agent-harness source capture --input <json|->
agent-harness source read --project <id> --run <id> --dispatch <id> --source <id> --path <relative-path>
agent-harness source search --project <id> --run <id> --dispatch <id> --query <literal> [--max <n>]
agent-harness memory query --input <json|-> [--memory-root <path>]
agent-harness memory propose|stage|promote|revoke|reject --input <json|-> --expected-revision <n> --command-id <id> [--memory-root <path>]
agent-harness memory recover [--memory-root <path>]
agent-harness memory export|import --input <json|-> [--command-id <id>] [--expected-revision <n>]
agent-harness features compile --extension <module> --input <json>
agent-harness run start --project <id> --run <id> --profile <id> --features <json> [--config <json>] [--execution-workspace <absolute-path>]
agent-harness run status --project <id> --run <id>
agent-harness run schedule --project <id> --run <id> [--max <n|auto>] [--runtime <plugin-id>]
agent-harness run dispatch --project <id> --run <id> --dispatch <id>
agent-harness run gates --project <id> --run <id> --scope <feature|stable|final> [--fresh] [--ids <id,id>] [--progress]
agent-harness run bind --project <id> --run <id> --dispatch <id> --agent <id> --runtime-receipt <json|->
agent-harness run submit --project <id> --run <id> --dispatch <id> --result <json|->
agent-harness run heartbeat --project <id> --run <id> --lease <id> --agent <id>
agent-harness run decision --project <id> --run <id> --decision <json>
agent-harness run gate --project <id> --run <id> --gate-result <json>
agent-harness run finding-open --project <id> --run <id> --finding <json>
agent-harness run finding-resolve --project <id> --run <id> --resolution <json>
agent-harness run reopen --project <id> --run <id> --feature <id> --reason <text>
agent-harness run artifact-rebase --project <id> --run <id> --artifact-digest <digest> --features <id,id> --decision-id <id>
agent-harness run recover --project <id> --run <id> [--mode <auto|ordinary-resume|hard-recovery>] [--capsule-verification <evidence-ref>] [--resolution-ref <evidence-ref>] [--expected-revision <n>] [--command-id <id>] [--dispositions <json>] [--verified-evidence <json>]
agent-harness run recovery-rollback --project <id> --run <id> --snapshot-ref <evidence-ref>
agent-harness run close --project <id> --run <id>
agent-harness run supersede --project <id> --run <id> --replacement-run <id> --plan-digest <digest> [--reason <text>]
agent-harness lifecycle plan --input <json|-> [--control-root <path>] [--data-root <path>]
agent-harness lifecycle preflight|start --workspace-id <id> ...
agent-harness lifecycle preflight --plan <json|-> [--no-write-probe]
agent-harness lifecycle start --plan <json|-> --preflight <json> --command-id <id>
agent-harness release activation-plan [--control-root <path>] [--data-root <path>] [--project <id>] [--project-descriptor <json>]...
agent-harness release activation-apply --plan <json|-> --command-id <id> --decision <json>
agent-harness evidence add --project <id> --run <id> --file <path> [--feature <id>] [--dispatch <id>]
agent-harness recovery assess --extension <module> --importer <id> --legacy-root <path>
agent-harness recovery plan --importer <id> --legacy-root <path> --project <id> --run <id>
agent-harness recovery capsule-create --extension <module> --importer <id> --legacy-root <path> --capsule <id> --command-id <id>
agent-harness recovery capsule-verify --capsule-root <path> --project <id> --run <id> [--verification-ttl-ms <n>]
agent-harness recovery source-unavailable --extension <module> --importer <id> --legacy-root <path> --project <id> --expected-revision 0 --command-id <id> [--decision <legacy-json>]
agent-harness defect validate --input <json>
agent-harness issue record --input <json|-> --command-id <id>
agent-harness issue status --issue <id>
agent-harness issue list
agent-harness issue triage --issue <id> --input <json|-> --expected-revision <n> --command-id <id> --decision <json>
agent-harness bootstrap plan --input <json|-> [--control-root <path>] [--data-root <path>]
agent-harness bootstrap apply --plan <json> --command-id <id> --decision <json> [--control-root <path>] [--data-root <path>]

All Authority and Evidence paths are under --data-root, never under the business repository.`);

if (command === 'help' || has('--help')) {
  help();
  process.exit(0);
}

try {
if ((command === 'run' || command === 'lifecycle') && subject === 'execute') {
  throw Object.assign(new Error('Agent execution is unavailable from the standalone CLI. Use a trusted host embedding with a visible adapter or an explicit unattended authorization adapter.'), { code: 'AGENT_CLI_EXECUTION_DISABLED' });
}
if (command === 'installation' && subject === 'init') {
  const installation = await initializeHarnessInstallation({ controlRoot: take('--control-root') });
  console.log(JSON.stringify({ ok: true, installation }, null, 2));
  process.exit(0);
}

const controlRoot = harnessControlRoot(take('--control-root'));
if (command === 'issue' && subject === 'record') {
  const receipt = await recordIssueIntake(await jsonInput('--input'), { controlRoot, commandId: take('--command-id') });
  console.log(JSON.stringify({ ok: true, receipt }, null, 2));
  process.exit(0);
}
if (command === 'issue' && subject === 'status') {
  console.log(JSON.stringify({ ok: true, issueId: take('--issue'), triage: await readIssueTriage(take('--issue'), { controlRoot }) }, null, 2));
  process.exit(0);
}
if (command === 'issue' && subject === 'list') {
  console.log(JSON.stringify({ ok: true, issues: await listIssueRecords({ controlRoot }) }, null, 2));
  process.exit(0);
}
if (command === 'issue' && subject === 'triage') {
  const output = await recordIssueTriage(take('--issue'), await jsonInput('--input'), {
    controlRoot,
    expectedRevision: Number(take('--expected-revision')),
    commandId: take('--command-id'),
    authorityDecision: take('--decision') ? await jsonFile(take('--decision')) : null,
  });
  console.log(JSON.stringify({ ok: true, ...output }, null, 2));
  process.exit(0);
}
const dataRoot = resolve(take('--data-root') ?? defaultDataRoot(controlRoot));
const scopedWorkspaceId = take('--workspace-id') ?? null;
if (scopedWorkspaceId) safeSegment(scopedWorkspaceId, 'workspaceId');
const runDataRoot = scopedWorkspaceId ? resolve(dataRoot, 'workspaces', scopedWorkspaceId) : dataRoot;
const releaseIdentity = await loadReleaseIdentity({ artifactDigest: take('--harness-digest') });
const extensionRegistry = new ExtensionRegistry({ dataRoot, controlRoot });

if (command === 'release' && subject === 'activation-plan') {
  const projectDescriptors = await Promise.all(takeAll('--project-descriptor').map(jsonFile));
  const plan = await createReleaseActivationPlan({ controlRoot, dataRoot, releaseIdentity, projectIds: takeAll('--project'), projectDescriptors });
  console.log(JSON.stringify({ ok: true, plan }, null, 2));
  process.exit(0);
}
if (command === 'release' && subject === 'activation-apply') {
  const output = await applyReleaseActivationPlan(await jsonInput('--plan'), { controlRoot, dataRoot, releaseIdentity, commandId: take('--command-id'), authorityDecision: take('--decision') ? await jsonFile(take('--decision')) : null, activateInstallation: true });
  console.log(JSON.stringify({ ok: true, ...output }, null, 2));
  process.exit(0);
}

if (command === 'bootstrap' && subject === 'plan') {
  const plan = await createBootstrapPlan(await jsonInput('--input'), { controlRoot, dataRoot, releaseIdentity });
  console.log(JSON.stringify({ ok: true, plan }, null, 2));
  process.exit(0);
}
if (command === 'bootstrap' && subject === 'apply') {
  const output = await applyBootstrapPlan(await jsonInput('--plan'), {
    controlRoot,
    dataRoot,
    releaseIdentity,
    commandId: take('--command-id'),
    authorityDecision: take('--decision') ? await jsonFile(take('--decision')) : null,
  });
  console.log(JSON.stringify({ ok: true, ...output }, null, 2));
  process.exit(0);
}

if (command === 'extension' && subject === 'register') {
  const receipt = await extensionRegistry.register(take('--module'), { cwd: process.cwd(), expectedRevision: Number(take('--expected-revision')), commandId: take('--command-id'), authorityDecision: take('--decision') ? await jsonFile(take('--decision')) : null });
  console.log(JSON.stringify({ ok: true, receipt }, null, 2));
  process.exit(0);
}
if (command === 'extension' && subject === 'list') {
  console.log(JSON.stringify({ ok: true, registry: await extensionRegistry.list() }, null, 2));
  process.exit(0);
}
if (command === 'extension' && subject === 'remove') {
  const receipt = await extensionRegistry.remove(take('--id'), { expectedRevision: Number(take('--expected-revision')), commandId: take('--command-id'), authorityDecision: take('--decision') ? await jsonFile(take('--decision')) : null });
  console.log(JSON.stringify({ ok: true, receipt }, null, 2));
  process.exit(0);
}

if (command === 'doctor') {
  const readiness = await inspectLifecycleReadiness({
    controlRoot,
    dataRoot,
    releaseIdentity,
    projectId: take('--project'),
    profileId: take('--profile'),
    extensionId: take('--extension-id'),
    executionWorkspaceRoot: take('--execution-workspace') ? resolve(take('--execution-workspace')) : undefined,
  });
  console.log(JSON.stringify({
    ok: true,
    version: releaseIdentity.version,
    artifactDigest: releaseIdentity.artifactDigest,
    node: process.version,
    projectRoot: harnessProjectRoot(),
    writeBoundary: 'standalone-control-root-only',
    ...readiness,
    initialized: readiness.storageReady,
  }, null, 2));
  process.exit(0);
}

if (command === 'defect' && subject === 'validate') {
  console.log(JSON.stringify({ ok: true, bundle: verifyDefectBundle(await jsonFile(take('--input'))) }, null, 2));
  process.exit(0);
}

if (command === 'project' && subject === 'list') {
  const projects = await new ProjectRegistry({ root: dataRoot, controlRoot }).list();
  console.log(JSON.stringify({ ok: true, projects }, null, 2));
  process.exit(0);
}
if (command === 'workspace' && await handleWorkspaceCommand({ subject, dataRoot, controlRoot, take, jsonFile, jsonInput })) process.exit(0);
if (command === 'source' && await handleSourceCommand({ subject, runDataRoot, controlRoot, dataRoot, scopedWorkspaceId, releaseIdentity, take, optionalNumber, jsonInput })) process.exit(0);
if (command === 'memory' && await handleMemoryCommand({ subject, runDataRoot, controlRoot, take, optionalNumber, jsonInput })) process.exit(0);

if (command === 'run' && subject === 'status') {
  console.log(JSON.stringify({ ok: true, ...(await readRunStatus({ controlRoot, dataRoot: runDataRoot, projectId: take('--project'), runId: take('--run') })) }, null, 2));
  process.exit(0);
}

const registeredExtensions = await extensionRegistry.loadInstalled();
const explicitExtensions = await Promise.all(takeAll('--extension').map(module => loadExtensionPack(module, { cwd: process.cwd(), controlRoot, requireArtifactManifest: true })));
const extensionsById = new Map(registeredExtensions.map(pack => [pack.id, pack]));
for (const pack of explicitExtensions) {
  const prior = extensionsById.get(pack.id);
  if (prior && prior.digest !== pack.digest) throw Object.assign(new Error(`Extension ${pack.id} conflicts with its registered artifact.`), { code: 'EXTENSION_EXPLICIT_CONFLICT' });
  extensionsById.set(pack.id, pack);
}
const extensions = [...extensionsById.values()];
if (command === 'workflow' && subject === 'list') {
  const project = await new ProjectRegistry({ root: runDataRoot, controlRoot, workspaceRegistry: new WorkspaceRegistry({ root: dataRoot, controlRoot }), workspaceId: scopedWorkspaceId }).get(take('--project'));
  const workflows = extensions.flatMap(extension => (extension.workflows ?? []).map(workflow => ({ id: workflow.id, version: workflow.version, artifactDigest: workflow.artifactDigest, profileId: workflow.profileId, extensionId: extension.id, actions: Object.keys(extension.commandManifest?.actions ?? {}) })))
    .filter(workflow => (project.extensions ?? []).some(extension => extension.id === workflow.extensionId) && (!project.workflows?.length || project.workflows.some(bound => bound.id === workflow.id && bound.artifactDigest === workflow.artifactDigest)));
  console.log(JSON.stringify({ ok: true, projectId: project.id, workflows }, null, 2));
  process.exit(0);
}
if (command === 'lifecycle' && subject === 'plan') {
  const input = await jsonInput('--input');
  const selectedWorkspace = input.workspaceId ?? scopedWorkspaceId ?? (input.workspaceAlias ? (await new WorkspaceRegistry({ root: dataRoot, controlRoot }).resolveAlias(input.workspaceAlias)).workspaceId : null);
  const harness = await createHarness({ controlRoot, dataRoot, workspaceId: selectedWorkspace, memoryRoot: take('--memory-root'), extensions, releaseIdentity, initializeStorage: false });
  const plan = await harness.createLifecyclePlan(input);
  console.log(JSON.stringify({ ok: true, plan }, null, 2));
  process.exit(0);
}
if (command === 'project' && subject === 'descriptor') {
  const capable = (explicitExtensions.length ? explicitExtensions : extensions).filter(pack => typeof pack.operations.createProjectDescriptor === 'function');
  if (capable.length !== 1) throw new Error('Exactly one descriptor-capable Extension Pack is required.');
  const descriptor = capable[0].operations.createProjectDescriptor(await jsonFile(take('--input')));
  if (!releaseIdentity.artifactDigest) throw Object.assign(new Error('Project Descriptor generation requires a verified Harness release artifact.'), { code: 'HARNESS_RELEASE_ARTIFACT_REQUIRED' });
  descriptor.harness ??= { version: releaseIdentity.version, artifactDigest: releaseIdentity.artifactDigest };
  descriptor.extensions = (descriptor.extensions ?? []).map(required => {
    const installed = extensions.find(pack => pack.id === required.id);
    if (!installed?.digest) throw Object.assign(new Error(`Project Descriptor requires an installed, verified Extension artifact: ${required.id}`), { code: 'PROJECT_EXTENSION_ARTIFACT_REQUIRED' });
    return { ...required, digest: installed.digest };
  });
  console.log(JSON.stringify(descriptor, null, 2));
  process.exit(0);
}

if (command === 'features' && subject === 'compile') {
  const input = await jsonFile(take('--input'));
  const capable = (explicitExtensions.length ? explicitExtensions : extensions).filter(pack => typeof pack.operations.compileFeatureGraph === 'function');
  if (capable.length !== 1) throw new Error('Exactly one compiler-capable Extension Pack is required.');
  const features = capable[0].operations.compileFeatureGraph(input);
  console.log(JSON.stringify(features, null, 2));
  process.exit(0);
}

  const readOnlyHarness = command === 'recovery' && ['assess', 'plan'].includes(subject);
  const harness = await createHarness({ controlRoot, dataRoot, workspaceId: scopedWorkspaceId, memoryRoot: take('--memory-root'), extensions, releaseIdentity, initializeStorage: !readOnlyHarness });
  if (command === 'project' && subject === 'register') {
    const runtimePluginId = take('--runtime');
    const rawInput = take('--descriptor') ? await jsonFile(take('--descriptor')) : { id: take('--id'), workspace: { root: resolve(take('--workspace')) }, profiles: String(take('--profiles') ?? '').split(',').filter(Boolean), policy: { agentExecutionMode: take('--agent-execution-mode'), defaultRuntimePlugin: runtimePluginId, runtimePlugins: runtimePluginId ? [runtimePluginId] : [], promptCodecPlugin: take('--prompt-codec') } };
    const input = {
      ...rawInput,
      harness: rawInput.harness ?? { version: releaseIdentity.version, artifactDigest: releaseIdentity.artifactDigest },
      extensions: (rawInput.extensions ?? []).map(required => {
        const installed = extensions.find(pack => pack.id === required.id);
        return required.digest || !installed?.digest ? required : { ...required, digest: installed.digest };
      }),
    };
    const descriptor = await harness.projectRegistry.register(input, { expectedRevision: Number(take('--expected-revision') ?? 0), commandId: take('--command-id') ?? newId('command'), authorityDecision: take('--decision') ? await jsonFile(take('--decision')) : null });
    console.log(JSON.stringify({ ok: true, descriptor }, null, 2));
  } else if (command === 'run' && subject === 'start') {
    const input = { projectId: take('--project'), runId: take('--run'), profileId: take('--profile'), features: await jsonFile(take('--features')), profileConfig: take('--config') ? await jsonFile(take('--config')) : {}, artifactDigest: take('--artifact-digest') ?? null, ...(take('--execution-workspace') ? { executionWorkspaceRoot: resolve(take('--execution-workspace')) } : {}) };
    const output = await harness.startRun(input, { commandId: take('--command-id') ?? newId('command') });
    console.log(JSON.stringify({ ok: true, state: output.state, reused: output.reused }, null, 2));
  } else if (command === 'lifecycle' && subject === 'start') {
    const output = await harness.startLifecyclePlan(await jsonInput('--plan'), { commandId: take('--command-id'), preflightReport: await preflightInput() });
    console.log(JSON.stringify({ ok: ['started', 'closed'].includes(output.status), ...output }, null, 2));
  } else if (command === 'lifecycle' && subject === 'preflight') {
    const output = await harness.createExecutionReadinessReport(await jsonInput('--plan'), { onGateProgress: progressWriter, probeWrite: !has('--no-write-probe') });
    console.log(JSON.stringify({ ok: output.executionReady, report: output }, null, 2));
  } else if (command === 'run' && subject === 'schedule') {
    const state = await harness.authorityStore.read(take('--project'), take('--run'));
    const output = await harness.dispatch(state.projectId, state.runId, { maxConcurrency: optionalNumber('--max'), runtimePluginId: take('--runtime') ?? null }, { expectedRevision: state.revision, commandId: take('--command-id') ?? newId('command') });
    console.log(JSON.stringify({ ok: true, ...output.result, revision: output.state.revision }, null, 2));
  } else if (command === 'run' && subject === 'dispatch') {
    const output = await harness.readDispatchPacket(take('--project'), take('--run'), take('--dispatch'));
    console.log(JSON.stringify({ ok: true, ...output }, null, 2));
  } else if (command === 'run' && subject === 'gates') {
    const runner = new ProjectGateRunner({ harness, onProgress: progressWriter });
    const output = await runner.run({ projectId: take('--project'), runId: take('--run'), scope: take('--scope') ?? 'final', forceFresh: has('--fresh'), gateIds: String(take('--ids') ?? '').split(',').filter(Boolean) });
    console.log(JSON.stringify({ ok: output.results.every(result => result.status === 'passed'), ...output }, null, 2));
  } else if (command === 'run' && subject === 'bind') {
    const state = await harness.authorityStore.read(take('--project'), take('--run'));
    const output = await harness.bindDispatch(state.projectId, state.runId, { dispatchId: take('--dispatch'), agentId: take('--agent'), runtimeReceipt: await jsonInput('--runtime-receipt') }, { expectedRevision: state.revision, commandId: take('--command-id') ?? newId('command') });
    console.log(JSON.stringify({ ok: true, lease: output.result.lease, revision: output.state.revision }, null, 2));
  } else if (command === 'run' && subject === 'submit') {
    const output = await harness.recordResult(take('--project'), take('--run'), take('--dispatch'), await jsonInput('--result'), { commandId: take('--command-id') ?? newId('command') });
    console.log(JSON.stringify({ ok: true, ...output.result, revision: output.state.revision }, null, 2));
  } else if (command === 'run' && subject === 'heartbeat') {
    const state = await harness.authorityStore.read(take('--project'), take('--run'));
    const leaseId = take('--lease');
    const agentId = take('--agent');
    const lease = state.leases.find(item => item.leaseId === leaseId);
    const output = await harness.recordHeartbeat(state.projectId, state.runId, { leaseId, dispatchId: lease?.dispatchId, agentId, progress: take('--progress') ?? null }, { expectedRevision: state.revision, commandId: take('--command-id') ?? newId('command') });
    console.log(JSON.stringify({ ok: true, ...output.result, revision: output.state.revision }, null, 2));
  } else if (command === 'run' && subject === 'decision') {
    const state = await harness.authorityStore.read(take('--project'), take('--run'));
    const decision = await jsonFile(take('--decision'));
    const output = await harness.kernel.recordDecision(state.projectId, state.runId, decision, { expectedRevision: state.revision, commandId: take('--command-id') ?? newId('command') });
    console.log(JSON.stringify({ ok: true, decision: output.result.decision, revision: output.state.revision }, null, 2));
  } else if (command === 'run' && subject === 'gate') {
    const state = await harness.authorityStore.read(take('--project'), take('--run'));
    const output = await harness.kernel.recordGate(state.projectId, state.runId, await jsonFile(take('--gate-result')), { expectedRevision: state.revision, commandId: take('--command-id') ?? newId('command') });
    console.log(JSON.stringify({ ok: true, gate: output.result.gate, revision: output.state.revision }, null, 2));
  } else if (command === 'run' && subject === 'finding-open') {
    const state = await harness.authorityStore.read(take('--project'), take('--run'));
    const output = await harness.kernel.recordFinding(state.projectId, state.runId, await jsonFile(take('--finding')), { expectedRevision: state.revision, commandId: take('--command-id') ?? newId('command') });
    console.log(JSON.stringify({ ok: true, finding: output.result.finding, revision: output.state.revision }, null, 2));
  } else if (command === 'run' && subject === 'finding-resolve') {
    const state = await harness.authorityStore.read(take('--project'), take('--run'));
    const output = await harness.kernel.resolveFinding(state.projectId, state.runId, await jsonFile(take('--resolution')), { expectedRevision: state.revision, commandId: take('--command-id') ?? newId('command') });
    console.log(JSON.stringify({ ok: true, finding: output.result.finding, revision: output.state.revision }, null, 2));
  } else if (command === 'run' && subject === 'reopen') {
    const state = await harness.authorityStore.read(take('--project'), take('--run'));
    const output = await harness.kernel.reopenFeature(state.projectId, state.runId, { featureId: take('--feature'), reason: take('--reason') }, { expectedRevision: state.revision, commandId: take('--command-id') ?? newId('command') });
    console.log(JSON.stringify({ ok: true, ...output.result, revision: output.state.revision }, null, 2));
  } else if (command === 'run' && subject === 'artifact-rebase') {
    const state = await harness.authorityStore.read(take('--project'), take('--run'));
    const input = { artifactDigest: take('--artifact-digest'), impactedFeatureIds: String(take('--features') ?? '').split(',').filter(Boolean), decisionId: take('--decision-id') };
    const output = await harness.kernel.rebaseArtifact(state.projectId, state.runId, input, { expectedRevision: state.revision, commandId: take('--command-id') ?? newId('command') });
    console.log(JSON.stringify({ ok: true, ...output.result, revision: output.state.revision }, null, 2));
  } else if (command === 'run' && subject === 'recover') {
    const state = await harness.authorityStore.read(take('--project'), take('--run'));
    const verificationRef = take('--capsule-verification');
    const requestedMode = take('--mode') ?? 'auto';
    const mode = requestedMode === 'auto' ? (verificationRef ? 'hard-recovery' : 'ordinary-resume') : requestedMode;
    const output = mode === 'hard-recovery'
      ? await harness.recovery.hardRecover({ projectId: state.projectId, runId: state.runId, verificationRef, resolutionRef: take('--resolution-ref'), dispositions: take('--dispositions') ? await jsonFile(take('--dispositions')) : {}, verifiedEvidenceRefs: take('--verified-evidence') ? await jsonFile(take('--verified-evidence')) : {} }, { expectedRevision: Number(take('--expected-revision') ?? state.revision), commandId: take('--command-id') ?? newId('command') })
      : await harness.kernel.recover(state.projectId, state.runId, { mode }, { expectedRevision: state.revision, commandId: take('--command-id') ?? newId('command') });
        console.log(JSON.stringify({ ok: true, ...output.result, revision: output.state.revision }, null, 2));
  } else if (command === 'run' && subject === 'recovery-rollback') {
    const state = await harness.authorityStore.read(take('--project'), take('--run'));
    const output = await harness.recovery.rollback({ projectId: state.projectId, runId: state.runId, rollbackSnapshotRef: take('--snapshot-ref') }, { expectedRevision: state.revision, commandId: take('--command-id') ?? newId('command') });
    console.log(JSON.stringify({ ok: true, ...output.result, revision: output.state.revision }, null, 2));
  } else if (command === 'run' && subject === 'close') {
    const state = await harness.authorityStore.read(take('--project'), take('--run'));
    const output = await harness.kernel.closeRun(state.projectId, state.runId, {}, { expectedRevision: state.revision, commandId: take('--command-id') ?? newId('command') });
    console.log(JSON.stringify({ ok: true, ...output.result, revision: output.state.revision }, null, 2));
  } else if (command === 'run' && subject === 'supersede') {
    const state = await harness.authorityStore.read(take('--project'), take('--run'));
    const output = await harness.kernel.supersedeRun(state.projectId, state.runId, { replacementRunId: take('--replacement-run'), planDigest: take('--plan-digest'), reason: take('--reason') }, { expectedRevision: state.revision, commandId: take('--command-id') ?? newId('command') });
    console.log(JSON.stringify({ ok: true, ...output.result, revision: output.state.revision }, null, 2));
  } else if (command === 'evidence' && subject === 'add') {
    const state = await harness.authorityStore.read(take('--project'), take('--run'));
    const evidence = await harness.evidenceStore.put(await readFile(resolve(take('--file'))), { projectId: state.projectId, ...(state.metadata?.workspaceRef ? { workspaceRef: state.metadata.workspaceRef } : {}), runId: state.runId, epoch: state.epoch, generation: state.generation, featureId: take('--feature') ?? null, dispatchId: take('--dispatch') ?? null, sourceDigest: state.sourceDigest, artifactDigest: state.artifactDigest, policyDigest: state.policyDigest, pluginSetDigest: state.pluginSetDigest, mediaType: take('--media-type') ?? 'application/octet-stream', labels: String(take('--labels') ?? '').split(',').filter(Boolean) });
    console.log(JSON.stringify({ ok: true, evidence }, null, 2));
  } else if (command === 'recovery' && subject === 'assess') {
    const report = await harness.recovery.assess(take('--importer'), { legacyRoot: resolve(take('--legacy-root')) });
    console.log(JSON.stringify({ ok: true, report }, null, 2));
  } else if (command === 'recovery' && subject === 'plan') {
    const plan = await harness.recovery.plan({ importerId: take('--importer'), legacyRoot: resolve(take('--legacy-root')), projectId: take('--project'), runId: take('--run') });
    console.log(JSON.stringify({ ok: true, plan }, null, 2));
  } else if (command === 'recovery' && subject === 'capsule-create') {
    const capsule = await harness.recovery.createCapsule({ importerId: take('--importer'), legacyRoot: resolve(take('--legacy-root')), capsuleId: take('--capsule'), commandId: take('--command-id'), maxBytes: take('--max-bytes') ? Number(take('--max-bytes')) : undefined, maxFiles: take('--max-files') ? Number(take('--max-files')) : undefined });
    console.log(JSON.stringify({ ok: true, capsule }, null, 2));
  } else if (command === 'recovery' && subject === 'capsule-verify') {
    const capsule = await harness.recovery.verifyCapsule(resolve(take('--capsule-root')), { projectId: take('--project'), runId: take('--run'), ttlMs: take('--verification-ttl-ms') ? Number(take('--verification-ttl-ms')) : undefined });
    console.log(JSON.stringify({ ok: true, capsule }, null, 2));
  } else if (command === 'recovery' && subject === 'source-unavailable') {
    const decisionPath = take('--decision');
    const output = await harness.recovery.recordUnavailableSource({ importerId: take('--importer'), projectId: take('--project'), legacyRoot: resolve(take('--legacy-root')), ...(decisionPath ? { decision: await jsonFile(decisionPath) } : {}) }, { expectedRevision: Number(take('--expected-revision')), commandId: take('--command-id') });
    console.log(JSON.stringify({ ok: true, ...output }, null, 2));
  } else {
    help();
    process.exitCode = 2;
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error.code ?? 'UNEXPECTED_ERROR', message: error.message, details: error.details }, null, 2));
  process.exitCode = 1;
}
