import { canonicalize } from './canonical.mjs';
import { assert } from './errors.mjs';

const types = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string']);
const supportedKeywords = new Set(['$schema', '$id', '$defs', '$ref', 'title', 'description', 'type', 'anyOf', 'oneOf', 'allOf', 'const', 'enum', 'required', 'properties', 'additionalProperties', 'items', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'pattern', 'format']);
const valueType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value === 'number' ? 'number' : typeof value;
const pointer = (document, fragment) => fragment.split('/').slice(1).reduce((value, segment) => value?.[segment.replaceAll('~1', '/').replaceAll('~0', '~')], document);

const resolveReference = (reference, rootSchema, schemas) => {
  const [file, fragment = ''] = reference.split('#');
  const document = file ? schemas.get(file) : rootSchema;
  assert(document, 'JSON_SCHEMA_REFERENCE_MISSING', `JSON Schema reference cannot be resolved: ${reference}`);
  const target = fragment ? pointer(document, fragment) : document;
  assert(target, 'JSON_SCHEMA_REFERENCE_MISSING', `JSON Schema fragment cannot be resolved: ${reference}`);
  return { schema: target, rootSchema: document };
};

export const validateJsonSchema = (value, schema, { schemas = new Map(), path = '$', rootSchema = schema } = {}) => {
  const errors = [];
  const visit = (input, rule, location, root) => {
    if (typeof rule === 'boolean') {
      if (!rule) errors.push(`${location}: rejected by boolean schema`);
      return;
    }
    if (rule.$ref) {
      const resolved = resolveReference(rule.$ref, root, schemas);
      visit(input, resolved.schema, location, resolved.rootSchema);
      return;
    }
    if (rule.anyOf && !rule.anyOf.some(candidate => validateJsonSchema(input, candidate, { schemas, path: location, rootSchema: root }).valid)) errors.push(`${location}: does not match anyOf`);
    if (rule.oneOf && rule.oneOf.filter(candidate => validateJsonSchema(input, candidate, { schemas, path: location, rootSchema: root }).valid).length !== 1) errors.push(`${location}: does not match exactly one oneOf branch`);
    for (const candidate of rule.allOf ?? []) visit(input, candidate, location, root);
    if (rule.const !== undefined && canonicalize(input) !== canonicalize(rule.const)) errors.push(`${location}: must equal const`);
    if (rule.enum && !rule.enum.some(candidate => canonicalize(input) === canonicalize(candidate))) errors.push(`${location}: is not an allowed enum value`);
    if (rule.type) {
      const allowed = Array.isArray(rule.type) ? rule.type : [rule.type];
      const actual = valueType(input);
      const matches = allowed.includes(actual) || (actual === 'integer' && allowed.includes('number'));
      if (!matches) { errors.push(`${location}: expected ${allowed.join('|')}, received ${actual}`); return; }
    }
    if (typeof input === 'string') {
      if (rule.minLength !== undefined && input.length < rule.minLength) errors.push(`${location}: shorter than minLength`);
      if (rule.maxLength !== undefined && input.length > rule.maxLength) errors.push(`${location}: longer than maxLength`);
      if (rule.pattern && !new RegExp(rule.pattern).test(input)) errors.push(`${location}: does not match pattern`);
      if (rule.format === 'date-time' && Number.isNaN(Date.parse(input))) errors.push(`${location}: is not a date-time`);
    }
    if (typeof input === 'number' && rule.minimum !== undefined && input < rule.minimum) errors.push(`${location}: below minimum`);
    if (typeof input === 'number' && rule.maximum !== undefined && input > rule.maximum) errors.push(`${location}: above maximum`);
    if (Array.isArray(input)) {
      if (rule.minItems !== undefined && input.length < rule.minItems) errors.push(`${location}: has fewer than minItems`);
      if (rule.maxItems !== undefined && input.length > rule.maxItems) errors.push(`${location}: has more than maxItems`);
      if (rule.uniqueItems && new Set(input.map(canonicalize)).size !== input.length) errors.push(`${location}: contains duplicate items`);
      if (rule.items) input.forEach((item, index) => visit(item, rule.items, `${location}[${index}]`, root));
    } else if (input && typeof input === 'object') {
      for (const name of rule.required ?? []) if (!Object.hasOwn(input, name)) errors.push(`${location}.${name}: is required`);
      for (const [name, child] of Object.entries(rule.properties ?? {})) if (Object.hasOwn(input, name)) visit(input[name], child, `${location}.${name}`, root);
      const known = new Set(Object.keys(rule.properties ?? {}));
      for (const [name, child] of Object.entries(input)) {
        if (known.has(name)) continue;
        if (rule.additionalProperties === false) errors.push(`${location}.${name}: additional property is forbidden`);
        else if (rule.additionalProperties && typeof rule.additionalProperties === 'object') visit(child, rule.additionalProperties, `${location}.${name}`, root);
      }
    }
  };
  visit(value, schema, path, rootSchema);
  return { valid: errors.length === 0, errors };
};

export const assertJsonSchema = (value, schema, { schemas, code = 'JSON_SCHEMA_VALIDATION_FAILED', label = 'value' } = {}) => {
  const result = validateJsonSchema(value, schema, { schemas });
  assert(result.valid, code, `${label} does not satisfy its JSON Schema.`, { errors: result.errors });
  return value;
};

export const assertSchemaDefinition = (schema, label = 'JSON Schema') => {
  assert(schema && typeof schema === 'object' && schema.$schema && schema.$id && (schema.type || schema.anyOf || schema.$ref), 'JSON_SCHEMA_DEFINITION_INVALID', `${label} is not a supported schema document.`);
  const visit = rule => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return;
    const unsupported = Object.keys(rule).filter(key => !supportedKeywords.has(key));
    assert(unsupported.length === 0, 'JSON_SCHEMA_KEYWORD_UNSUPPORTED', `${label} uses unsupported JSON Schema keywords.`, { unsupported });
    for (const type of Array.isArray(rule.type) ? rule.type : rule.type ? [rule.type] : []) assert(types.has(type), 'JSON_SCHEMA_DEFINITION_INVALID', `${label} declares an unsupported type: ${type}`);
    if (rule.required) assert(Array.isArray(rule.required) && rule.required.every(value => typeof value === 'string'), 'JSON_SCHEMA_DEFINITION_INVALID', `${label} has an invalid required list.`);
    if (rule.pattern) new RegExp(rule.pattern);
    for (const value of Object.values(rule.$defs ?? {})) visit(value);
    for (const value of Object.values(rule.properties ?? {})) visit(value);
    if (rule.items) visit(rule.items);
    if (rule.additionalProperties && typeof rule.additionalProperties === 'object') visit(rule.additionalProperties);
    for (const value of rule.anyOf ?? []) visit(value);
    for (const value of rule.oneOf ?? []) visit(value);
    for (const value of rule.allOf ?? []) visit(value);
  };
  visit(schema);
  return schema;
};
