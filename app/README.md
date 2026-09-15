Written for: engineers joining the StellarTrust mobile app.

# StellarTrust — mobile app

The React Native client for StellarTrust. Same platform, same database, same
contracts of record as the web app in [`frontend/`](../frontend) — this is not a
parallel implementation.

- **Stack**: Expo SDK 57, React Native 0.86, React 19, TypeScript 6 (strict),
  React Query. New Architecture only — SDK 57 dropped the old bridge.
- **Design**: the tokens in [`docs/DESIGN.md`](../docs/DESIGN.md), transcribed
  to [`src/theme/tokens.ts`](src/theme/tokens.ts). Signal Yellow `#fcd535` on a
  near-black canvas, Inter for UI, IBM Plex Mono for money, rates and IDs.
- **Types**: every API call is typed against `@stellartrust/shared`. The app
  defines no DTO of its own, so a contract change fails the build rather than
  drifting.

## Running it

```bash
cp .env.example .env        # then set EXPO_PUBLIC_API_BASE_URL
npm install
npm start                   # Metro + dev client
```

The backend must be running (`npm run dev --prefix ../backend`). On a physical
device, `EXPO_PUBLIC_API_BASE_URL` must be your machine's LAN address, not
`localhost` — the phone resolves `localhost` to itself.

`npm run start:go` uses Expo Go, which is enough to browse most of the app.
**Push notifications will not work there** — Expo Go dropped remote push in
SDK 53, so the app detects it and disables them rather than crashing
([`lib/notifications.ts`](src/lib/notifications.ts) explains how). Expect other
native paths — camera capture in particular — to be limited or unavailable too.

A dev client is the supported way to run this app: `npm run android` or
`npm run ios`. Use Expo Go only for quick UI work.

## How it is laid out

```
src/
  api/          transport + typed client over the StellarTrust API
  auth/         SEP-10 sign-in, device keystore wallet, WalletConnect, session
  components/   the design system as RN primitives
  features/     one folder per surface (escrow, settlement, rwa, kyc, …)
  lib/          money math, query config, idempotency, notifications, config
  navigation/   tab + stack navigators and their typed route map
  theme/        design tokens and the status→colour map
```

A feature folder owns its screens and its own logic; anything two features share
moves to `lib/` or `components/`.

## The parts worth reading first

**Authentication is SEP-10, not a password.** The server issues a challenge
transaction, the wallet signs it, the server verifies that signature against the
account. There is no credential to phish. Two wallet kinds sit behind one
[`signer.ts`](src/auth/signer.ts) interface:

- **On-device** ([`device-wallet.ts`](src/auth/device-wallet.ts)) — a Stellar key
  generated on the handset, stored in the Keychain / Android Keystore as
  `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (so it is in no backup), read only after a
  biometric or passcode check, and never sent anywhere.
- **External** ([`wallet-connect.ts`](src/auth/wallet-connect.ts)) — WalletConnect
  v2; the key stays in the user's own wallet app. Optional: without
  `EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID` the app offers only the on-device path.

**Verification is real.** The user photographs their document and their face;
the captures are quality-checked, downscaled, stripped of EXIF, and uploaded to a
*private* bucket, and the application carries opaque `storage://` references. The
decision comes from the verification provider plus the platform's own risk engine
and human review — there is no scenario picker. See
[`features/kyc/`](src/features/kyc/) here and
[`modules/kyc/`](../backend/src/modules/kyc/) on the backend.

**Money mutations are idempotent.** Every such call carries an
`Idempotency-Key`, minted once per *intent* and reused across every retry —
including the user pressing the button again after a failure. The transport
([`api/http.ts`](src/api/http.ts)) retries a mutation **only** when it carries
one; without a key it never retries, because a repeat the server cannot
recognise as a duplicate is a double spend.

**Escrow steps route themselves.** Some transitions are signed by the server as
arbiter and some need the acting party's own key. Which is which is a property of
the deployment, read from `/api/payments/capabilities` at runtime —
[`useEscrowAction.ts`](src/features/escrow/useEscrowAction.ts) handles both, and
falls through to the wallet path if the gateway answers 409.

## Tests

```bash
npm test
```

They cover the parts that would cost real money to get wrong: minor-unit
conversion at both the 2dp and 7dp scales, the transport's retry rules
(especially the never-retry-an-unkeyed-mutation guard), who may take which escrow
step, the capture quality gate, and notification-payload validation.

## Building

[`eas.json`](eas.json) defines three profiles.

```bash
npm run build:dev       # dev client, internal distribution
npm run build:preview    # testnet build against the deployed API
npm run build:prod       # store build
npm run ota              # push a JS-only update to the production channel
```

The `production` profile deliberately does **not** hardcode
`EXPO_PUBLIC_API_BASE_URL` or `EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID`. Set them as
EAS environment variables for that profile — a production API host committed to
the repo is the kind of thing that ends up pointing a store build at staging.

## What the backend needs

Beyond the standing requirements in the root README:

- **A private `kyc-documents` storage bucket.** Must exist and must not be
  public. Migration
  [`0024`](../infra/supabase/migrations/0024_kyc_document_storage_and_push_tokens.sql)
  explains the split; the bucket itself is infrastructure, created alongside
  `avatars`.
- **Migration 0024**, for `device_push_tokens`.
- **`KYC_PROVIDER`** — `sandbox` locally; a real provider (`sumsub`, with its
  credentials) elsewhere. The config refuses to boot a staging or production
  deployment on the sandbox provider, because deciding identity from fixture
  strings is not verification and every money surface is gated on that badge.
- **`EXPO_ACCESS_TOKEN`** (optional) for push delivery receipts and higher rate
  limits.
