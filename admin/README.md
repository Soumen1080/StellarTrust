# StellarTrust — Operations console

A **separately deployed, privately hosted** admin application. It is not part
of the public API and must never share a hostname with it: the point of the
split is that someone who finds the public site finds no admin surface at all.

## Why it is its own application

The console is the widest data grant in the platform — every user's position,
every queue, and the controls that approve KYC. Mounting that on the public API
means the most valuable endpoints in the system sit on the hostname most
exposed to the internet.

So it lives here instead, reads Postgres **directly**, and the public backend
has no `/api/admin` at all. There is nothing to find, probe, or exploit on the
public host.

## What it can and cannot do

**Can:** read metrics, tokenizations, disputes, treasury movements and the
audit trail; decide KYC and asset reviews; refuse a held withdrawal; edit the
verification routing policy.

**Cannot approve a withdrawal.** Approving one submits a real Stellar payment,
which needs the signing key — and putting that key here would mean two systems
able to move funds instead of one. This console can *stop* a payout; only the
backend can send one.

## Two factors, both required

Signing in takes two steps, and a session exists only after both:

1. **Password** — the server checks it and returns a random, single-use,
   five-minute challenge. **No session is created.**
2. **Wallet signature** — the operator signs that challenge with the key in
   `ADMIN_WALLET`. Only now does a session exist.

The ordering is the security property. Whoever holds a leaked password gets a
nonce to sign and nothing else: a password can be phished, reused, read from a
hosting dashboard, or found in a backup, and none of that yields a private key.
Only the *public* key lives on this host, so a compromise of this server still
cannot sign on the operator's behalf.

Failures at either step count toward the same lockout, so an attacker who has
the password does not get unlimited attempts at the second factor.

Freighter is used when present; otherwise the page falls back to pasting a
signature. That is not a weaker path — the same signature is checked the same
way — and it means an operator without the extension can still sign from a
wallet they trust rather than being locked out of their own console.

## Setup

```bash
npm install

# Generate a password hash. Use at least 12 characters — this is the only
# credential between the internet and every user's data.
npm run hash-password -- "your long password here"

cp .env.example .env   # fill in DATABASE_URL, the hash, SESSION_SECRET, …
npm run dev
```

`ADMIN_WALLET` is the Stellar address that must sign in alongside the
password. `ADMIN_REVIEWER_USER_ID` must be a real `users.id`. The database refuses a KYC
or asset decision that does not name who made it (migrations 0018 and 0022),
and this console signs in with a password rather than a wallet, so it has no
user identity of its own.

## Deploying

Deploy as a normal Node service (`npm run build && npm start`) on a host
**separate from the public API**. Then, in order of how much they matter:

1. **Set `ADMIN_IP_ALLOWLIST`**, or put the deployment behind a VPN. This is
   the control that makes a leaked password survivable. It is optional only
   because a wrong allowlist locks you out of your own console.
2. **Use a long, unique password.** It is not shared with anything else and
   nothing else can rotate it for you.
3. **Consider a read-mostly database role.** The console writes to exactly four
   tables: `verification_policies`, `kyc_reviews`, `assets`, and
   `treasury_movements` (plus `audit_log`). Granting more is granting an
   attacker more if this app is ever compromised.

The app refuses to start if any required setting is missing or malformed — a
console that boots half-configured is either unusable or unsafe, and both are
worse than a clear failure at deploy time.

## Tests

```bash
npm test
```

31 tests, all about one question: can anything reach the console without both
factors? They run against the real password hashing and real Ed25519 signature
verification rather than stubs — a stubbed check is a test that would still
pass with authentication removed entirely.

The load-bearing case is "correct password, wrong wallet": that is exactly what
an attacker holding a leaked password has, and it is refused.
