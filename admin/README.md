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

## Setup

```bash
npm install

# Generate a password hash. Use at least 12 characters — this is the only
# credential between the internet and every user's data.
npm run hash-password -- "your long password here"

cp .env.example .env   # fill in DATABASE_URL, the hash, SESSION_SECRET, …
npm run dev
```

`ADMIN_REVIEWER_USER_ID` must be a real `users.id`. The database refuses a KYC
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

24 tests, all about one question: can anything reach the console without the
password? They run against the real password verification rather than a stub —
a stubbed password check is a test that would still pass with authentication
removed entirely.
