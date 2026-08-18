/**
 * Contract ↔ backend binding drift check.
 *
 * The gateways call the contracts through hand-written TypeScript interfaces
 * (`EscrowContractClient`, `RwaContractClient`) that the SDK's dynamic
 * `contract.Client` is cast to. Nothing enforces that those interfaces still
 * describe the Rust: rename an argument in `lib.rs` and TypeScript stays green
 * until a real transaction fails at simulation. `cargo test` does not catch it
 * either — it only tests Rust against Rust.
 *
 * This closes the loop. It reads the `contractspecv0` custom section out of the
 * built WASM — the same spec the SDK downloads to build a client — and compares
 * the function names and argument names/order against a checked-in manifest.
 * The manifest is what the backend's own test asserts its interfaces against,
 * so a change in Rust must be acknowledged in one place and shows up as a diff.
 *
 * Usage:
 *   node contracts/scripts/check-bindings.mjs           # verify (CI)
 *   node contracts/scripts/check-bindings.mjs --write   # accept current Rust
 *
 * Requires the contracts to have been built first:
 *   stellar contract build   (or: cargo build --release --target wasm32v1-none)
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_ROOT = join(HERE, "..");

// `contracts/` is a Rust workspace with no node_modules of its own, and ESM
// resolves imports relative to this file rather than the working directory.
// Anchor the lookup at the backend package — the one that owns the SDK, and
// the one whose contract clients this check exists to protect.
// `cereal` is the SDK's re-export of js-xdr, whose XdrReader walks a stream of
// concatenated XDR values — which is exactly what the spec section is.
const { xdr, cereal } = createRequire(
  join(CONTRACTS_ROOT, "..", "backend", "package.json"),
)("@stellar/stellar-sdk");
const MANIFEST = join(CONTRACTS_ROOT, "contract-spec.json");
const PACKAGES = ["escrow", "rwa_token"];
const SPEC_SECTION = "contractspecv0";

/** Locate a built WASM, tolerating both target triples the CLI has used. */
function findWasm(pkg) {
  const candidates = [
    join(CONTRACTS_ROOT, "target", "wasm32v1-none", "release", `${pkg}.wasm`),
    join(
      CONTRACTS_ROOT,
      "target",
      "wasm32-unknown-unknown",
      "release",
      `${pkg}.wasm`,
    ),
  ];
  return candidates.find((path) => existsSync(path));
}

// ── Minimal WASM reader: we only need one custom section ────────────────────
// A WASM module is a header followed by (id, size, payload) sections. Custom
// sections have id 0 and begin with a name; `contractspecv0` is the one Soroban
// writes the contract spec into. Walking the section table is a few lines and
// avoids pulling in a WASM parser for a build-time check.

function readVarUint32(buffer, offset) {
  let result = 0;
  let shift = 0;
  let position = offset;
  for (;;) {
    const byte = buffer[position];
    if (byte === undefined) throw new Error("Truncated LEB128 value in WASM");
    position += 1;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value: result >>> 0, offset: position };
}

function readCustomSection(buffer, wantedName) {
  if (buffer.length < 8) throw new Error("Not a WASM module");
  let offset = 8; // magic (4) + version (4)
  while (offset < buffer.length) {
    const sectionId = buffer[offset];
    offset += 1;
    const size = readVarUint32(buffer, offset);
    const payloadStart = size.offset;
    const payloadEnd = payloadStart + size.value;

    if (sectionId === 0) {
      const nameLength = readVarUint32(buffer, payloadStart);
      const nameEnd = nameLength.offset + nameLength.value;
      const name = buffer.subarray(nameLength.offset, nameEnd).toString("utf8");
      if (name === wantedName) return buffer.subarray(nameEnd, payloadEnd);
    }
    offset = payloadEnd;
  }
  return undefined;
}

/** Decode the spec section into the function signatures we care about. */
function readFunctions(specBytes) {
  const reader = new cereal.XdrReader(specBytes);
  const functions = [];
  while (!reader.eof) {
    const entry = xdr.ScSpecEntry.read(reader);
    if (entry.switch().name !== "scSpecEntryFunctionV0") continue;
    const fn = entry.functionV0();
    functions.push({
      name: fn.name().toString(),
      args: fn.inputs().map((input) => input.name().toString()),
    });
  }
  // Sorted so the manifest is a stable diff, not an artifact of link order.
  return functions.sort((a, b) => a.name.localeCompare(b.name));
}

async function buildSpec() {
  const spec = {};
  for (const pkg of PACKAGES) {
    const wasmPath = findWasm(pkg);
    if (!wasmPath) {
      throw new Error(
        `${pkg}.wasm was not found under contracts/target. Run ` +
          "`stellar contract build` (or cargo build --release --target " +
          "wasm32v1-none) before checking bindings.",
      );
    }
    const wasm = await readFile(wasmPath);
    const section = readCustomSection(wasm, SPEC_SECTION);
    if (!section) {
      throw new Error(`${pkg}.wasm has no '${SPEC_SECTION}' section`);
    }
    spec[pkg] = readFunctions(section);
  }
  return spec;
}

function describe(spec) {
  return Object.entries(spec)
    .map(
      ([pkg, fns]) =>
        `${pkg}:\n` +
        fns.map((fn) => `  ${fn.name}(${fn.args.join(", ")})`).join("\n"),
    )
    .join("\n\n");
}

const write = process.argv.includes("--write");
const actual = await buildSpec();

if (write) {
  await writeFile(MANIFEST, `${JSON.stringify(actual, null, 2)}\n`, "utf8");
  console.log(`Wrote ${MANIFEST}\n\n${describe(actual)}`);
  process.exit(0);
}

let expected;
try {
  expected = JSON.parse(await readFile(MANIFEST, "utf8"));
} catch {
  console.error(
    `No manifest at ${MANIFEST}. Generate it with --write and commit it.`,
  );
  process.exit(1);
}

if (JSON.stringify(expected) === JSON.stringify(actual)) {
  console.log("Contract spec matches the committed manifest.");
  process.exit(0);
}

console.error(
  "Contract spec has drifted from contracts/contract-spec.json.\n\n" +
    "The backend's TypeScript contract clients are written against this " +
    "manifest, so a change here needs a matching change in\n" +
    "  backend/src/modules/escrow/escrow.gateway.ts (EscrowContractClient)\n" +
    "  backend/src/modules/rwa/rwa.gateway.ts (RwaContractClient)\n\n" +
    `--- committed ---\n${describe(expected)}\n\n--- built ---\n${describe(actual)}`,
);
process.exit(1);
