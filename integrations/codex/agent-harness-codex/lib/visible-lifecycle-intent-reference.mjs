import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { decodeVisibleLifecycleIntent } from './visible-lifecycle-intent.mjs';

const referencePattern = /^ref\.([A-Za-z0-9_-]+)\.(lifecycle_[a-f0-9-]{36})\.([a-f0-9]{64})$/;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
  : resolve(left) === resolve(right);

export const storeVisibleLifecycleIntentReference = async ({ encodedIntent, dataRoot }) => {
  const intent = decodeVisibleLifecycleIntent(encodedIntent);
  if (!isAbsolute(dataRoot ?? '') || !samePath(intent.harness.dataRoot, dataRoot)) fail('VISIBLE_LIFECYCLE_INTENT_REFERENCE_ROOT_INVALID', 'Intent reference requires the verified data root.');
  if (process.platform === 'win32' && /^C:[\\/]/i.test(resolve(dataRoot))) fail('VISIBLE_LIFECYCLE_INTENT_REFERENCE_ROOT_INVALID', 'Source-link intent references cannot be written to C:\\ on Windows.');
  const directory = resolve(dataRoot, 'visible-intents');
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, `${intent.commandId}.json`), JSON.stringify({ encodedIntent }), { flag: 'wx', mode: 0o600 });
  return `ref.${Buffer.from(dataRoot, 'utf8').toString('base64url')}.${intent.commandId}.${intent.intentDigest}`;
};

export const resolveVisibleLifecycleIntentArgument = async argument => {
  if (!argument?.startsWith('ref.')) return decodeVisibleLifecycleIntent(argument);
  const match = argument.match(referencePattern);
  if (!match) fail('VISIBLE_LIFECYCLE_INTENT_REFERENCE_INVALID', 'Intent reference syntax is invalid.');
  const [, rootEncoding, commandId, intentDigest] = match;
  const dataRoot = Buffer.from(rootEncoding, 'base64url').toString('utf8');
  if (!isAbsolute(dataRoot) || Buffer.from(dataRoot, 'utf8').toString('base64url') !== rootEncoding) fail('VISIBLE_LIFECYCLE_INTENT_REFERENCE_ROOT_INVALID', 'Intent reference data root is invalid.');
  const file = resolve(dataRoot, 'visible-intents', `${commandId}.json`);
  const child = relative(resolve(dataRoot), file);
  if (child.startsWith('..') || isAbsolute(child)) fail('VISIBLE_LIFECYCLE_INTENT_REFERENCE_ROOT_INVALID', 'Intent reference escaped its data root.');
  const fileStat = await lstat(file).catch(() => fail('VISIBLE_LIFECYCLE_INTENT_REFERENCE_UNAVAILABLE', 'Intent reference file is unavailable.'));
  if (!fileStat.isFile() || fileStat.size > 65536) fail('VISIBLE_LIFECYCLE_INTENT_REFERENCE_INVALID', 'Intent reference file is invalid.');
  let record;
  try { record = JSON.parse(await readFile(file, 'utf8')); }
  catch { fail('VISIBLE_LIFECYCLE_INTENT_REFERENCE_INVALID', 'Intent reference record is unreadable.'); }
  if (!record || Object.keys(record).length !== 1 || typeof record.encodedIntent !== 'string') fail('VISIBLE_LIFECYCLE_INTENT_REFERENCE_INVALID', 'Intent reference record is invalid.');
  const intent = decodeVisibleLifecycleIntent(record.encodedIntent);
  if (intent.commandId !== commandId || intent.intentDigest !== intentDigest || !samePath(intent.harness.dataRoot, dataRoot)) fail('VISIBLE_LIFECYCLE_INTENT_REFERENCE_MISMATCH', 'Intent reference does not match its verified contents.');
  return intent;
};
