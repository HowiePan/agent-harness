import { digestJson } from './canonical.mjs';
import { assert } from './errors.mjs';

export const NODE_TASK_CONTRACT_VERSION = '1.0';

const idPattern = /^[a-z][a-z0-9.-]*$/;
const inputSources = new Set(['intent', 'feature', 'workspace', 'source-manifest', 'memory', 'quality-target', 'upstream']);
const uniqueStrings = (values, label) => {
  assert(Array.isArray(values) && values.length > 0 && values.every(value => typeof value === 'string' && value.trim()), 'NODE_TASK_FIELD_INVALID', `${label} must be a non-empty string array.`);
  const normalized = [...new Set(values.map(value => value.trim()))];
  assert(normalized.length === values.length, 'NODE_TASK_FIELD_INVALID', `${label} must not contain duplicates.`);
  return normalized;
};

const normalizeInputs = inputs => {
  assert(Array.isArray(inputs), 'NODE_TASK_INPUTS_INVALID', 'Node Task inputs must be an array.');
  const normalized = inputs.map(input => {
    assert(input && typeof input === 'object' && !Array.isArray(input), 'NODE_TASK_INPUT_INVALID', 'Every Node Task input must be an object.');
    const allowed = new Set(['id', 'source', 'path', 'nodeId', 'portId', 'schemaId', 'required', 'description']);
    const unknown = Object.keys(input).filter(key => !allowed.has(key));
    assert(unknown.length === 0, 'NODE_TASK_INPUT_FIELD_UNKNOWN', 'Node Task input contains unknown fields.', { unknown });
    assert(idPattern.test(input.id ?? ''), 'NODE_TASK_INPUT_ID_INVALID', `Invalid Node Task input ID: ${input.id ?? '<missing>'}`);
    assert(inputSources.has(input.source), 'NODE_TASK_INPUT_SOURCE_INVALID', `Invalid Node Task input source: ${input.source ?? '<missing>'}`);
    assert(typeof input.description === 'string' && input.description.trim(), 'NODE_TASK_INPUT_DESCRIPTION_REQUIRED', `Node Task input ${input.id} requires a description.`);
    if (input.source === 'upstream') {
      assert(idPattern.test(input.nodeId ?? '') && typeof input.portId === 'string' && input.portId && typeof input.schemaId === 'string' && input.schemaId, 'NODE_TASK_UPSTREAM_INPUT_INVALID', `Upstream Node Task input ${input.id} requires nodeId, portId, and schemaId.`);
      assert(input.path === undefined, 'NODE_TASK_UPSTREAM_PATH_FORBIDDEN', `Upstream Node Task input ${input.id} cannot declare path.`);
    } else {
      assert(typeof input.path === 'string' && input.path, 'NODE_TASK_INPUT_PATH_REQUIRED', `Node Task input ${input.id} requires a path.`);
      assert(input.nodeId === undefined && input.portId === undefined && input.schemaId === undefined, 'NODE_TASK_INPUT_UPSTREAM_FIELDS_FORBIDDEN', `Non-upstream Node Task input ${input.id} cannot declare upstream fields.`);
    }
    return Object.freeze({ ...structuredClone(input), description: input.description.trim(), required: input.required !== false });
  });
  assert(new Set(normalized.map(input => input.id)).size === normalized.length, 'NODE_TASK_INPUT_DUPLICATE', 'Node Task input IDs must be unique.');
  return normalized;
};

export const defineNodeTaskContract = input => {
  assert(input && typeof input === 'object' && !Array.isArray(input), 'NODE_TASK_REQUIRED', 'Every Agent Node requires a Node Task Contract.');
  const allowed = new Set(['schemaVersion', 'taskDigest', 'role', 'objective', 'instructions', 'inputs', 'steps', 'constraints', 'acceptance', 'evidenceRequirements']);
  const unknown = Object.keys(input).filter(key => !allowed.has(key));
  assert(unknown.length === 0, 'NODE_TASK_FIELD_UNKNOWN', 'Node Task Contract contains unknown fields.', { unknown });
  const role = input.role;
  assert(role && typeof role === 'object' && !Array.isArray(role) && idPattern.test(role.id ?? '') && typeof role.description === 'string' && role.description.trim(), 'NODE_TASK_ROLE_INVALID', 'Node Task role requires a stable ID and description.');
  assert(Object.keys(role).every(key => ['id', 'description'].includes(key)), 'NODE_TASK_ROLE_FIELD_UNKNOWN', 'Node Task role contains unknown fields.');
  assert(typeof input.objective === 'string' && input.objective.trim(), 'NODE_TASK_OBJECTIVE_REQUIRED', 'Node Task objective is required.');
  const steps = input.steps;
  assert(Array.isArray(steps) && steps.length > 0, 'NODE_TASK_STEPS_REQUIRED', 'Node Task requires at least one ordered step.');
  const normalizedSteps = steps.map(step => {
    assert(step && typeof step === 'object' && !Array.isArray(step) && idPattern.test(step.id ?? '') && typeof step.instruction === 'string' && step.instruction.trim(), 'NODE_TASK_STEP_INVALID', 'Every Node Task step requires a stable ID and instruction.');
    assert(Object.keys(step).every(key => ['id', 'instruction'].includes(key)), 'NODE_TASK_STEP_FIELD_UNKNOWN', 'Node Task step contains unknown fields.');
    return Object.freeze({ id: step.id, instruction: step.instruction.trim() });
  });
  assert(new Set(normalizedSteps.map(step => step.id)).size === normalizedSteps.length, 'NODE_TASK_STEP_DUPLICATE', 'Node Task step IDs must be unique.');
  const body = {
    schemaVersion: NODE_TASK_CONTRACT_VERSION,
    role: Object.freeze({ id: role.id, description: role.description.trim() }),
    objective: input.objective.trim(),
    instructions: Object.freeze(uniqueStrings(input.instructions, 'Node Task instructions')),
    inputs: Object.freeze(normalizeInputs(input.inputs ?? [])),
    steps: Object.freeze(normalizedSteps),
    constraints: Object.freeze(uniqueStrings(input.constraints, 'Node Task constraints')),
    acceptance: Object.freeze(uniqueStrings(input.acceptance, 'Node Task acceptance')),
    evidenceRequirements: Object.freeze(uniqueStrings(input.evidenceRequirements, 'Node Task evidenceRequirements')),
  };
  assert(input.schemaVersion === undefined || input.schemaVersion === NODE_TASK_CONTRACT_VERSION, 'NODE_TASK_VERSION_INVALID', `Unsupported Node Task Contract version: ${input.schemaVersion}`);
  const taskDigest = digestJson(body);
  assert(input.taskDigest === undefined || input.taskDigest === taskDigest, 'NODE_TASK_DIGEST_MISMATCH', 'Node Task Contract digest changed.');
  return Object.freeze({ ...body, taskDigest });
};

export const taskFeatureProjection = taskInput => {
  const task = defineNodeTaskContract(taskInput);
  return {
    task: structuredClone(task),
    ownerRole: task.role.id,
    acceptance: [...task.acceptance],
    steps: task.steps.map(step => ({ id: step.id, title: step.instruction })),
  };
};
