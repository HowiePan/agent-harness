import { digestJson } from '../../canonical.mjs';
import { assert } from '../../errors.mjs';
import { envelope } from '../contracts.mjs';

export const createJsonCodec = ({ manifest }) => ({
  async encode(packet) {
    const text = `${JSON.stringify(packet, null, 2)}\n`;
    return envelope(manifest, 'receipt', { operation: 'encode', mediaType: 'application/json', text, packetDigest: digestJson(packet) });
  },
  async decode(input) {
    const value = typeof input === 'string' ? JSON.parse(input) : structuredClone(input);
    assert(value && typeof value === 'object' && !Array.isArray(value), 'CODEC_RESULT_INVALID', 'Decoded result must be an object.');
    return envelope(manifest, 'receipt', { operation: 'decode', value, resultDigest: digestJson(value) });
  },
});
