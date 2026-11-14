import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;
const FORMAT_PREFIX = 'scrypt';

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derivedKey = scryptSync(password, salt, KEY_LENGTH);
  return `${FORMAT_PREFIX}$${salt.toString('hex')}$${derivedKey.toString('hex')}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  try {
    const [prefix, saltHex, hashHex, extra] = encoded.split('$');
    if (prefix !== FORMAT_PREFIX || !saltHex || !hashHex || extra !== undefined) return false;

    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    if (salt.length !== 16 || expected.length !== KEY_LENGTH) return false;

    const actual = scryptSync(password, salt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
