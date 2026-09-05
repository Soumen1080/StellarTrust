/**
 * Turn a password into the hash `ADMIN_PASSWORD_HASH` expects.
 *
 *   npm run hash-password -- "your password here"
 *
 * The password is taken as an argument rather than prompted for, so it works
 * in a non-interactive shell. That does mean it lands in shell history —
 * clear it afterwards, or prefix the command with a space where your shell
 * honours that.
 */
import { hashPassword } from "../lib/password.js";

const password = process.argv[2];

if (!password) {
  console.error(
    'Usage: npm run hash-password -- "your password"\n\n' +
      "Choose something long. This is the only credential between the\n" +
      "internet and every user's data.",
  );
  process.exit(1);
}

/**
 * Warn on a short password rather than refusing it.
 *
 * It used to refuse under 12 characters. That was the wrong call for a tool
 * whose operator is the person carrying the risk: the length that is right
 * depends on what else guards the console, and here two other things do — the
 * wallet second factor, which means a guessed password alone opens nothing,
 * and the login lockout, which caps guesses at five per fifteen minutes.
 *
 * So this states the cost and lets the operator decide, which is the honest
 * shape for a warning. It still says so every time, because a warning that
 * only appears once is one that gets forgotten.
 */
if (password.length < 12) {
  console.warn(
    `\nWarning: that password is ${password.length} characters.\n\n` +
      "Short passwords, and ones built from a name plus digits, are what\n" +
      "cracking tools generate first. Two things reduce the risk here: the\n" +
      "wallet signature means a guessed password alone opens nothing, and the\n" +
      "lockout caps guessing at 5 attempts per 15 minutes.\n\n" +
      "Proceeding.",
  );
}

const hash = await hashPassword(password);
console.log("\nAdd this to the admin console's environment:\n");
console.log(`ADMIN_PASSWORD_HASH=${hash}\n`);
