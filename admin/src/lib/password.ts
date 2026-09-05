/**
 * Password hashing and verification.
 *
 * Uses Node's built-in `scrypt` rather than adding bcrypt or argon2. Three
 * reasons: scrypt is memory-hard and purpose-built for exactly this, it needs
 * no native compilation (which is what makes bcrypt awkward to deploy), and
 * `Rules.md` §4 wants a decision entry for every new dependency — one that can
 * be avoided entirely is better than one that is merely justified.
 *
 * Format: `scrypt$N$r$p$<salt-hex>$<hash-hex>`. The parameters travel with the
 * hash so they can be raised later without invalidating existing passwords: a
 * hash made at today's cost still verifies after the cost is increased.
 */
import {
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

/**
 * `promisify(scrypt)` collapses the overloads and loses the options argument,
 * so it is wrapped by hand. The options matter here — the cost parameters are
 * the whole security property.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/**
 * Cost parameters. N=2^16 takes roughly 100ms on ordinary hardware — slow
 * enough that guessing is expensive, fast enough that a legitimate sign-in
 * does not feel broken.
 */
const N = 65_536;
const r = 8;
const p = 1;
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, {
    N,
    r,
    p,
    // Node's default memory limit is below what N=2^16 needs, so it is raised
    // explicitly. Without this the call throws rather than running slowly,
    // which is a confusing failure to debug.
    maxmem: 256 * 1024 * 1024,
  });
  return `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false for a malformed hash rather than throwing: a corrupted or
 * truncated `ADMIN_PASSWORD_HASH` should refuse the sign-in, not crash the
 * request handler and leak a stack trace about what the value looked like.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, rawN, rawR, rawP, saltHex, hashHex] = parts;
  const parsedN = Number(rawN);
  const parsedR = Number(rawR);
  const parsedP = Number(rawP);
  if (!parsedN || !parsedR || !parsedP || !saltHex || !hashHex) return false;

  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(hashHex, "hex");
    actual = await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length, {
      N: parsedN,
      r: parsedR,
      p: parsedP,
      maxmem: 256 * 1024 * 1024,
    });
  } catch {
    return false;
  }

  // Constant-time: a plain `===` leaks how many leading bytes matched, which
  // over enough attempts is enough to reconstruct the hash.
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
