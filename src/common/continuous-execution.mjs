import { assert } from './errors.mjs';
import { digestJson } from './canonical.mjs';

export const CONTINUOUS_EXECUTION = 'continuous-execution/1';
export const DEFAULT_CONTINUOUS_EXECUTION = Object.freeze({
  version: CONTINUOUS_EXECUTION,
  recovery: Object.freeze({ cyclesPerProblem: 3, diagnosticsPerCycle: 2, sameStrategyFailures: 2, stagnantCycles: 3 }),
  resources: Object.freeze({ helperMemoryMiB: 512, buildMemoryMiB: 2048, testMemoryMiB: 2048,
    packageMemoryMiB: 2048, cpuPercent: 25, helperProcesses: 4, buildProcesses: 16,
    displayBytes: 1048576, logBytes: 67108864, streamFiles: 65536, streamBytes: 1073741824 }),
});
export const validateContinuousExecution = input => {
  if (input === undefined || input === null) return null;
  assert(input.version === CONTINUOUS_EXECUTION && Object.keys(input).every(k => ['version','recovery','resources'].includes(k)),
    'CONTINUOUS_POLICY_INVALID', 'Use an explicit versioned continuous execution policy.');
  const value = structuredClone(DEFAULT_CONTINUOUS_EXECUTION);
  const maxima = { recovery: { cyclesPerProblem: 10, diagnosticsPerCycle: 3, sameStrategyFailures: 3, stagnantCycles: 10 },
    resources: { helperMemoryMiB: 2048, buildMemoryMiB: 8192, testMemoryMiB: 8192, packageMemoryMiB: 8192,
      cpuPercent: 50, helperProcesses: 8, buildProcesses: 32, displayBytes: 4194304,
      logBytes: 268435456, streamFiles: 1000000, streamBytes: 17179869184 } };
  for (const group of ['recovery','resources']) {
    assert(input[group] === undefined || input[group] && typeof input[group] === 'object' && !Array.isArray(input[group]),
      'CONTINUOUS_POLICY_INVALID', `Invalid ${group}.`);
    for (const [key,n] of Object.entries(input[group] ?? {})) {
      assert(Object.hasOwn(maxima[group],key) && Number.isSafeInteger(n) && n > 0 && n <= maxima[group][key],
        'CONTINUOUS_POLICY_INVALID', `Invalid ${group}.${key}.`);
      value[group][key]=n;
    }
  }
  assert(value.resources.logBytes >= value.resources.displayBytes, 'CONTINUOUS_POLICY_INVALID', 'Log quota must cover the display window.');
  return value;
};
export const continuousPolicy = state => state?.metadata?.continuousExecution ?? null;
export const continuousConfigurationDelta = (beforeText,afterText) => {
  const before=JSON.parse(beforeText),after=JSON.parse(afterText);
  const {executionPolicy,...remaining}=after.project;
  const policy=validateContinuousExecution(executionPolicy);
  assert(policy && after.schemaVersion==='1.2' && before.project.executionPolicy===undefined
    && digestJson({...after,schemaVersion:before.schemaVersion,project:remaining})===digestJson(before),
  'CONTINUOUS_MIGRATION_INVALID','Only the approved execution policy and schema may change.');
  return policy;
};

// Neither error names, source edits, Agent identities nor Run IDs mint a problem.
export const executionProblemId = feature => digestJson({ root: feature.logicalRoot,
  task: feature.task ?? null, acceptance: feature.acceptance ?? [],
  checks: feature.metadata?.deliveryBatch?.checks ?? feature.gatePlan ?? [] });
export const interventionProblemId = (state, item) => item.problemId ?? (() => {
  const submission=state.submissions?.find(s=>s.submissionId===item.sourceSubmissionId);
  const feature=state.features?.find(f=>f.id===submission?.featureId);
  return feature ? executionProblemId(feature) : null;
})();
export const problemCycle = (state,feature) => state.attempts?.[`${feature.logicalRoot}:task:${executionProblemId(feature)}:failure`]?.cycleGeneration ?? 0;
export const problemHistory = (state, feature) => (state.metadata?.interruptionLedger ?? [])
  .filter(item=>continuousPolicy(state) ? interventionProblemId(state,item)===executionProblemId(feature)
    && (item.cycleGeneration??0)===problemCycle(state,feature) : item.logicalRoot===feature.logicalRoot);
export const executionBudgetBlocked = (state, feature) => !continuousPolicy(state) && Object.values(state.attempts ?? {}).some(item =>
  item.logicalRoot===feature.logicalRoot && item.exhausted && (!continuousPolicy(state)
    || item.problemId===executionProblemId(feature)));

export const stagnantExecutionCycles = (state, feature) => {
  const ids=new Set(state.features.filter(f=>f.logicalRoot===feature.logicalRoot && f.kind!=='execution-diagnostic').map(f=>f.id));
  let count=0;
  for(const s of [...state.submissions].reverse()) {
    if(!ids.has(s.featureId))continue;
    if(s.result.status==='completed')break;
    if(state.attempts[s.attemptBudgetKey]?.budgetKind==='progress')break;
    count++;
  }
  return count;
};
