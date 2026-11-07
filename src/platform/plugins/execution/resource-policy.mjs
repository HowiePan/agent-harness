import { assert } from '../../../common/errors.mjs';
import { validateContinuousExecution } from '../../../common/continuous-execution.mjs';
import { SCRIPT_RESOURCE_LIMITS } from './resource-guard.mjs';

export const resourceClassLimits = (input, resourceClass='helper', inputMode='bounded') => {
  const policy=validateContinuousExecution(input);
  assert(['helper','build','test','package'].includes(resourceClass) && ['bounded','stream'].includes(inputMode),
    'RESOURCE_CLASS_INVALID','Select a declared deterministic resource class and input mode.');
  if(!policy) {
    assert(resourceClass==='helper' && inputMode==='bounded','RESOURCE_POLICY_BINDING_REQUIRED','Extended resources require a pinned project policy.');
    return {...SCRIPT_RESOURCE_LIMITS};
  }
  const r=policy.resources;
  return {...SCRIPT_RESOURCE_LIMITS,memoryBytes:r[`${resourceClass}MemoryMiB`]*1024**2,
    cpuPercent:r.cpuPercent,maxProcesses:resourceClass==='helper'?r.helperProcesses:r.buildProcesses,
    maxOutputBytes:r.displayBytes,maxLogBytes:r.logBytes,
    ...(inputMode==='stream'?{maxInputFiles:r.streamFiles,maxInputBytes:r.streamBytes}:{})};
};
