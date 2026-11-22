// A file's CID as tiles name their files: CIDv1, raw codec (0x55), sha-256, base32 ("bafkrei…").
import { createHash } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function rawCid(bytes) {
  const digest = createHash('sha256').update(bytes).digest();
  const cid = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]);
  return 'b' + base32(cid);
}
