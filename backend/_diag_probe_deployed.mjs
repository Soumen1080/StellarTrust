const BASE = "https://stellartrust.onrender.com";
async function call(label, method, path, headers = {}, body) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method, headers: { "content-type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    console.log(`[${label}] ${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 250)}`);
  } catch (e) { console.log(`[${label}] ERR ${e.message}`); }
}
await call("no-token", "GET", "/api/auth/me");
await call("bogus-token", "GET", "/api/auth/me", { authorization: "Bearer zzz-not-a-real-token" });
await call("dev-token", "GET", "/api/auth/me", { authorization: "Bearer dev-local-token" });
await call("orders-list-no-auth", "GET", "/api/payments/orders");
