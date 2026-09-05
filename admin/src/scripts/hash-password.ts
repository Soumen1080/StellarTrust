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

if (password.length < 12) {
  console.error(
    `Refusing: that password is ${password.length} characters.\n\n` +
      "Use at least 12. This console can approve KYC and read every user's\n" +
      "position; a password worth guessing is a password that will be.",
  );
  process.exit(1);
}

const hash = await hashPassword(password);
console.log("\nAdd this to the admin console's environment:\n");
console.log(`ADMIN_PASSWORD_HASH=${hash}\n`);
