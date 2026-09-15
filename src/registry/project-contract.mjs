import { readFileSync } from 'node:fs';
import { assert } from '../errors.mjs';
import { EXECUTION_CLASSES, assertExecutionClass } from '../execution-boundary.mjs';
import { validateJsonSchema } from '../json-schema.mjs';
import { resolveLifecycleExecutionPolicy } from '../plugins/runtime/execution-policy.mjs';

const inputSchema = JSON.parse(readFileSync(new URL('../../schemas/project-descriptor-input.schema.json', import.meta.url), 'utf8'));
const recordSchema = JSON.parse(readFileSync(new URL('../../schemas/project-descriptor.schema.json', import.meta.url), 'utf8'));
const inputKeys = Object.freeze(['id', 'harness', 'workspace', 'profiles', 'extensions', 'policy', 'gateRecipes', 'artifactProviders']);
const inputKeySet = new Set(inputKeys);

const assertPlainObject = (value, code, message) => assert(value && typeof value === 'object' && !Array.isArray(value), code, message);

export const projectDescriptorInput = value => Object.fromEntries(inputKeys.filter(key => value?.[key] !== undefined).map(key => [key, structuredClone(value[key])]));

export const assertProjectDescriptorInput = (input, { strictIdentity = true } = {}) => {
  assertPlainObject(input, 'PROJECT_DESCRIPTOR_INVALID', 'Project Descriptor input must be an object.');
  const extras = Object.keys(input).filter(key => !inputKeySet.has(key));
  assert(extras.length === 0, 'PROJECT_DESCRIPTOR_ADDITIONAL_PROPERTY', 'Project Descriptor input contains persisted or unknown properties.', { extras });
  assertPlainObject(input.workspace, 'PROJECT_DESCRIPTOR_INVALID', 'Project Descriptor requires a workspace object.');
  if (input.policy !== undefined) assertPlainObject(input.policy, 'PROJECT_POLICY_INVALID', 'Project Descriptor policy must be an object.');
  assert(!Object.hasOwn(input.policy ?? {}, 'executionGrant') && !Object.hasOwn(input.policy ?? {}, 'lifecycleExecutionGrant') && !Object.hasOwn(input.policy ?? {}, 'authorization'), 'DESCRIPTOR_EXECUTION_AUTHORIZATION_FORBIDDEN', 'Project Descriptor policy cannot contain execution authorization or grants.');
  for (const [action, execution] of Object.entries(input.policy?.actionExecution ?? {})) {
    assertPlainObject(execution, 'PROJECT_ACTION_EXECUTION_INVALID', `Project action execution policy must be an object: ${action}`);
    assert(!Object.hasOwn(execution, 'authorization') && !Object.hasOwn(execution, 'executionGrant') && !Object.hasOwn(execution, 'lifecycleExecutionGrant'), 'LEGACY_DESCRIPTOR_AUTHORIZATION_FORBIDDEN', 'Project Descriptor actionExecution is configuration, not user authority; persisted execution authorization is forbidden.');
  }
  assert(Array.isArray(input.gateRecipes ?? []), 'PROJECT_GATE_RECIPES_INVALID', 'Project Descriptor gateRecipes must be an array.');
  assert((input.gateRecipes ?? []).every(value => value && typeof value === 'object' && !Array.isArray(value)), 'PROJECT_GATE_RECIPES_INVALID', 'Every Project gate recipe must be an object.');
  for (const recipe of input.gateRecipes ?? []) assertExecutionClass(recipe.executionClass, EXECUTION_CLASSES.DETERMINISTIC_PROCESS, { code: 'GATE_EXECUTION_CLASS_INVALID', subject: `Gate Recipe ${recipe.id ?? '<unknown>'}` });
  assert(Array.isArray(input.artifactProviders ?? []), 'PROJECT_ARTIFACT_PROVIDERS_INVALID', 'Project Descriptor artifactProviders must be an array.');
  assert((input.artifactProviders ?? []).every(value => typeof value === 'string'), 'PROJECT_ARTIFACT_PROVIDERS_INVALID', 'Every Project artifact provider must be a string ID.');
  if (strictIdentity) {
    const result = validateJsonSchema(input, inputSchema);
    assert(result.valid, 'PROJECT_DESCRIPTOR_SCHEMA_INVALID', 'Project Descriptor input does not satisfy its production Schema.', { errors: result.errors });
    resolveLifecycleExecutionPolicy({ project: input });
    for (const action of Object.keys(input.policy?.actionExecution ?? {})) {
      assert(/^[a-z0-9][a-z0-9.-]+$/.test(action), 'PROJECT_ACTION_EXECUTION_KEY_INVALID', `Project action execution key is invalid: ${action}`);
      resolveLifecycleExecutionPolicy({ project: input, action });
    }
  }
  return input;
};

export const assertProjectDescriptorRecord = (record, { strictIdentity = true } = {}) => {
  if (!strictIdentity) return record;
  const result = validateJsonSchema(record, recordSchema);
  assert(result.valid, 'PROJECT_DESCRIPTOR_RECORD_INVALID', 'Persisted Project Descriptor does not satisfy its registry Schema.', { errors: result.errors });
  return record;
};

export const projectDescriptorSchemas = Object.freeze({ input: inputSchema, record: recordSchema });
