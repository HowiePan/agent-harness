import { assert } from '../../common/errors.mjs';

export const EXECUTION_CLASSES = Object.freeze({
  AGENT_REASONING: 'agent-reasoning',
  DETERMINISTIC_PROCESS: 'deterministic-process',
  AUTHORITY_CONTROL: 'authority-control',
});

export const EXTENSION_OPERATION_CLASSES = Object.freeze({
  PURE_PLANNER: 'pure-planner',
});

export const assertExecutionClass = (value, expected, { code = 'EXECUTION_CLASS_INVALID', subject = 'Execution node' } = {}) => {
  assert(value === expected, code, `${subject} must declare executionClass ${expected}.`, { expected, actual: value ?? null });
  return value;
};
