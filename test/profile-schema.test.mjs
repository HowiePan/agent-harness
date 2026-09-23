import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateJsonSchema } from '../src/common/json-schema.mjs';

const schemasRoot = new URL('../schemas/', import.meta.url);
const profilesRoot = new URL('../profiles/', import.meta.url);

const loadSchemas = async () => {
  const schemas = new Map();
  for (const name of await readdir(schemasRoot)) {
    if (name.endsWith('.json')) schemas.set(name, JSON.parse(await readFile(new URL(name, schemasRoot), 'utf8')));
  }
  return schemas;
};

test('every shipped workflow profile satisfies the profile Schema', async () => {
  const schemas = await loadSchemas();
  const schema = schemas.get('workflow-profile.schema.json');
  assert.ok(schema, 'workflow-profile.schema.json must exist');
  const names = (await readdir(profilesRoot)).filter(name => name.endsWith('.profile.json'));
  assert.ok(names.length > 0, 'at least one profile must ship');
  for (const name of names) {
    const profile = JSON.parse(await readFile(new URL(name, profilesRoot), 'utf8'));
    const result = validateJsonSchema(profile, schema, { schemas });
    assert.equal(result.valid, true, `${name} violates the profile Schema: ${result.errors.join('; ')}`);
  }
});

test('profile Schema rejects unknown fields and invalid severities', async () => {
  const schemas = await loadSchemas();
  const schema = schemas.get('workflow-profile.schema.json');
  const base = { id: 'probe', version: '1.0.0', stages: ['work'], quality: { blockingSeverities: ['P0'], allowCurrentDebt: false } };
  assert.equal(validateJsonSchema(base, schema, { schemas }).valid, true);
  assert.equal(validateJsonSchema({ ...base, extra: true }, schema, { schemas }).valid, false);
  assert.equal(validateJsonSchema({ ...base, quality: { blockingSeverities: ['P4'], allowCurrentDebt: false } }, schema, { schemas }).valid, false);
  assert.equal(validateJsonSchema({ ...base, stages: [] }, schema, { schemas }).valid, false);
  assert.equal(validateJsonSchema({ ...base, version: '1.0' }, schema, { schemas }).valid, false);
});
