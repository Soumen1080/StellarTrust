import { randomUUID } from "node:crypto";

const BASE = "http://localhost:8080";
const TOKEN = "dev-local-token";

async function call(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  console.log(`\n${method} ${path} -> HTTP ${res.status}`);
  console.log(typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2));
  return { status: res.status, body: parsed };
}

const idem = () => ({ "idempotency-key": randomUUID() });

const sellerId = process.argv[2]; // pass a real seller user id
if (!sellerId) {
  console.error("Usage: node _diag_http.mjs <sellerUserId>");
  process.exit(1);
}

// 1) Create order (happy path with a real seller)
const created = await call(
  "POST",
  "/api/payments/orders",
  { sellerId, amount: { amount: "10000", currency: "USD" } },
  idem(),
);

const orderId = created.body?.order?.id;
if (!orderId) {
  console.log("\nNo order id; stopping.");
  process.exit(0);
}

// 2) Walk the escrow state machine: accept(seller) can't be done as buyer, but
//    buyer drives deposit->lock. We are the buyer. Seller must accept first.
//    We cannot act as seller here, so just try lock to observe gateway/DB path.
await call("POST", `/api/payments/orders/${orderId}/accept`, {}, idem());
await call("POST", `/api/payments/orders/${orderId}/deposit`, {}, idem());
await call("POST", `/api/payments/orders/${orderId}/lock`, {}, idem());

// 3) Open a dispute against the order (tests dispute_records table)
await call("POST", "/api/disputes", { orderId, reason: "item_not_received" }, idem());
