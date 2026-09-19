import { assert } from '../errors.mjs';

const tokenPattern = /^[a-z][a-z0-9-]{0,31}$/;

const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

export const defineCommandManifest = input => {
  assert(input?.protocolVersion === '1.0', 'COMMAND_MANIFEST_VERSION_INVALID', 'Command manifest protocolVersion must be 1.0.');
  assert(input.id && tokenPattern.test(input.id), 'COMMAND_MANIFEST_ID_INVALID', 'Command manifest requires a stable lowercase ID.');
  assert(input.profileId && typeof input.profileId === 'string', 'COMMAND_MANIFEST_PROFILE_REQUIRED', 'Command manifest requires a Profile ID.');
  assert(input.actions && typeof input.actions === 'object' && !Array.isArray(input.actions), 'COMMAND_MANIFEST_ACTIONS_REQUIRED', 'Command manifest requires actions.');

  const aliases = new Set();
  const actions = {};
  for (const [id, action] of Object.entries(input.actions)) {
    assert(tokenPattern.test(id), 'COMMAND_ACTION_ID_INVALID', `Command action ID is invalid: ${id}`);
    const actionAliases = [...(action.aliases ?? [])];
    for (const alias of [id, ...actionAliases]) {
      assert(tokenPattern.test(alias), 'COMMAND_ACTION_ALIAS_INVALID', `Command action alias is invalid: ${alias}`);
      assert(!aliases.has(alias), 'COMMAND_ACTION_ALIAS_DUPLICATE', `Command action alias is duplicated: ${alias}`);
      aliases.add(alias);
    }
    assert(action.targetKind && typeof action.targetKind === 'string', 'COMMAND_ACTION_TARGET_REQUIRED', `Command action ${id} requires targetKind.`);
    assert(action.presets && typeof action.presets === 'object' && !Array.isArray(action.presets), 'COMMAND_ACTION_PRESETS_REQUIRED', `Command action ${id} requires presets.`);
    const presets = {};
    for (const [presetId, preset] of Object.entries(action.presets)) {
      assert(tokenPattern.test(presetId), 'COMMAND_PRESET_ID_INVALID', `Command preset ID is invalid: ${presetId}`);
      assert(typeof preset.scope === 'string' && preset.scope, 'COMMAND_PRESET_SCOPE_REQUIRED', `Command preset ${id}/${presetId} requires scope.`);
      assert(typeof preset.stateChanging === 'boolean', 'COMMAND_PRESET_MUTATION_INVALID', `Command preset ${id}/${presetId} requires a boolean stateChanging value.`);
      if (preset.argumentPrefix !== undefined) assert(typeof preset.argumentPrefix === 'string' && preset.argumentPrefix, 'COMMAND_PRESET_PREFIX_INVALID', `Command preset ${id}/${presetId} has an invalid argumentPrefix.`);
      presets[presetId] = structuredClone(preset);
    }
    const defaultPreset = action.defaultPreset ?? 'default';
    assert(presets[defaultPreset], 'COMMAND_DEFAULT_PRESET_UNKNOWN', `Command action ${id} has an unknown default preset: ${defaultPreset}`);
    actions[id] = { ...structuredClone(action), aliases: actionAliases, defaultPreset, presets };
  }
  return freeze({ protocolVersion: '1.0', id: input.id, profileId: input.profileId, ...(input.workflowId ? { workflowId: input.workflowId } : {}), actions });
};

export const resolveCommandIntent = (manifestInput, { action: requestedAction, target, arguments: inputArguments = [] } = {}) => {
  const manifest = defineCommandManifest(manifestInput);
  assert(tokenPattern.test(requestedAction ?? ''), 'COMMAND_ACTION_INVALID', 'Command action is invalid.');
  assert(typeof target === 'string' && target.trim(), 'COMMAND_TARGET_REQUIRED', 'Command target is required.');
  assert(Array.isArray(inputArguments), 'COMMAND_ARGUMENTS_INVALID', 'Command arguments must be an array.');
  const entry = Object.entries(manifest.actions).find(([id, action]) => id === requestedAction || action.aliases.includes(requestedAction));
  assert(entry, 'COMMAND_ACTION_UNKNOWN', `Command action is not declared by ${manifest.id}: ${requestedAction}`);
  const [actionId, action] = entry;
  assert(inputArguments.length <= 1, 'COMMAND_ARGUMENT_COUNT_INVALID', `Command action ${actionId} accepts at most one preset argument.`);
  const requestedPreset = inputArguments[0];
  let presetId = requestedPreset ?? action.defaultPreset;
  let preset = action.presets[presetId];
  let selector;
  if (!preset && requestedPreset) {
    const dynamic = Object.entries(action.presets).find(([, candidate]) => candidate.argumentPrefix && requestedPreset.startsWith(candidate.argumentPrefix));
    if (dynamic) {
      [presetId, preset] = dynamic;
      selector = requestedPreset.slice(preset.argumentPrefix.length);
      assert(selector, 'COMMAND_PRESET_SELECTOR_REQUIRED', `Command preset ${actionId}/${presetId} requires a selector after ${preset.argumentPrefix}`);
    }
  }
  assert(preset, 'COMMAND_PRESET_UNKNOWN', `Command preset is not declared by ${manifest.id}: ${actionId}/${presetId}`);
  return freeze({
    protocolVersion: '1.0',
    manifestId: manifest.id,
    profileId: manifest.profileId,
    ...(manifest.workflowId ? { workflowId: manifest.workflowId } : {}),
    action: actionId,
    requestedAction,
    target: target.trim(),
    targetKind: action.targetKind,
    preset: presetId,
    ...(requestedPreset ? { requestedPreset } : {}),
    ...(selector ? { selector } : {}),
    ...structuredClone(preset),
  });
};
