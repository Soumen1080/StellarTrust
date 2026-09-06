/**
 * The sign-in page — two factors, in two steps.
 *
 *   1. Password  → the server returns a random challenge, and no session
 *   2. Signature → the operator signs that challenge with the authorised
 *                  wallet, and only then does a session exist
 *
 * Deliberately says nothing about what this system is. A page reading
 * "StellarTrust Admin — production" tells anyone who stumbles onto it exactly
 * what they have found and what it is worth attacking.
 *
 * Signing happens in Freighter when it is available, and falls back to a paste
 * box otherwise. The fallback is not a weaker path: the same signature is
 * checked the same way, and it means an operator on a machine without the
 * extension can still sign from a wallet they trust rather than being locked
 * out of their own console.
 */
export function loginPage(
  error: string | null,
  /**
   * The wallet that may sign in, shown so the operator knows which account to
   * pick before they open their wallet — not a secret, and already knowable to
   * anyone who reaches this page by trying to sign in.
   */
  expectedWallet = "",
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Sign in</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh; display: grid; place-items: center;
    background: #0b0e11; color: #eaecef; padding: 16px;
    font: 15px/1.5 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .box {
    width: min(420px, 100%);
    background: #1e2329; border: 1px solid #2b3139; border-radius: 12px;
    padding: 32px;
  }
  h1 { margin: 0 0 4px; font-size: 18px; }
  p.sub { margin: 0 0 24px; font-size: 13px; color: #707a8a; }
  label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 8px; }
  input, textarea {
    width: 100%; padding: 10px 12px; border-radius: 6px;
    border: 1px solid #2b3139; background: #0b0e11; color: #eaecef;
    font: inherit;
  }
  textarea { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 12px; resize: vertical; }
  input:focus, textarea:focus { outline: 2px solid #fcd535; outline-offset: 1px; }
  button {
    width: 100%; margin-top: 20px; padding: 11px; border: 0; border-radius: 6px;
    background: #fcd535; color: #181a20; font: inherit; font-weight: 600;
    cursor: pointer;
  }
  button:hover:not([disabled]) { background: #f0b90b; }
  button[disabled] { opacity: .5; cursor: not-allowed; }
  .msg {
    margin: 0 0 16px; padding: 10px 12px; border-radius: 6px; font-size: 13px;
  }
  .msg.err { background: rgba(246,70,93,.1); border: 1px solid rgba(246,70,93,.3); color: #f6465d; }
  .msg.info { background: rgba(59,130,246,.1); border: 1px solid rgba(59,130,246,.3); color: #93c5fd; }
  .step { display: none; }
  .step.on { display: block; }
  .steps { display: flex; gap: 6px; margin-bottom: 20px; }
  .dot { flex: 1; height: 3px; border-radius: 2px; background: #2b3139; }
  .dot.on { background: #fcd535; }
  code {
    display: block; margin-top: 8px; padding: 8px; border-radius: 6px;
    background: #0b0e11; border: 1px solid #2b3139;
    font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 11px;
    word-break: break-all; color: #929aa5;
  }
  .link {
    display: block; width: 100%; margin-top: 10px; padding: 0; border: 0;
    background: none; color: #707a8a; font: inherit; font-size: 13px;
    text-decoration: underline; cursor: pointer;
  }
  /* The password field and its show/hide toggle. The toggle sits inside the
     field's box rather than beside it, so revealing the password does not
     shift the layout underneath it. */
  .reveal { position: relative; }
  .reveal input { padding-right: 68px; }
  .reveal button {
    position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
    width: auto; margin: 0; padding: 5px 10px; border-radius: 4px;
    background: #2b3139; color: #929aa5; font: inherit; font-size: 12px;
    font-weight: 500; cursor: pointer;
  }
  .reveal button:hover:not([disabled]) { background: #3a4149; color: #eaecef; }
  .reveal button:focus-visible { outline: 2px solid #fcd535; outline-offset: 1px; }
  /* The wallet picker. One row per wallet found in the browser, so the
     operator chooses the same way they would on the main site rather than
     being assumed to have one specific extension. */
  .wallets { display: grid; gap: 8px; margin-top: 16px; }
  .wallet {
    display: flex; align-items: center; gap: 10px; width: 100%; margin: 0;
    padding: 12px; border: 1px solid #2b3139; border-radius: 8px;
    background: #0b0e11; color: #eaecef; font: inherit; font-weight: 500;
    text-align: left; cursor: pointer;
  }
  .wallet:hover:not([disabled]) { background: #2b3139; border-color: #3a4149; }
  .wallet .tick { margin-left: auto; font-size: 12px; color: #0ecb81; }
  .none {
    margin: 16px 0 0; padding: 12px; border-radius: 8px;
    background: rgba(240,185,11,.08); border: 1px solid rgba(240,185,11,.25);
    font-size: 13px; color: #f0b90b;
  }
</style>
</head>
<body>
<div class="box">
  <h1>Sign in</h1>
  <p class="sub">Restricted access. Two factors required.</p>

  <div class="steps"><div class="dot on" id="d1"></div><div class="dot" id="d2"></div></div>
  <div id="msg">${error ? `<p class="msg err" role="alert">${escapeHtml(error)}</p>` : ""}</div>

  <!-- Step 1 -->
  <div class="step on" id="step1">
    <label for="password">Password</label>
    <div class="reveal">
      <input id="password" type="password" autocomplete="current-password" autofocus>
      <button type="button" id="toggle" aria-pressed="false"
              aria-label="Show password" title="Show password">Show</button>
    </div>
    <button id="next" type="button">Continue</button>
  </div>

  <!-- Step 2 -->
  <div class="step" id="step2">
    <p class="msg info">Connect the authorised wallet to continue.</p>
    <p class="sub" style="margin:0 0 4px">Only this wallet can sign in:</p>
    <code id="expectedWallet">${escapeHtml(expectedWallet)}</code>
    <button id="connect" type="button">Connect Wallet</button>
    <details style="margin-top:16px">
      <summary style="cursor:pointer;font-size:13px;color:#707a8a">Message being signed</summary>
      <textarea id="challenge" rows="3" readonly style="margin-top:8px"></textarea>
    </details>
    <button class="link" id="manual" type="button">Sign another way</button>
    <div id="pasteWrap" style="display:none;margin-top:16px">
      <label for="signature">Signed transaction (XDR)</label>
      <textarea id="signature" rows="3" placeholder="Paste the signed transaction envelope"></textarea>
      <button id="submitSig" type="button">Verify signature</button>
    </div>
  </div>
</div>

<script src="/assets/wallet-kit.js"></script>
<script>
(function () {
  "use strict";
  var challengeId = null;

  function show(text, kind) {
    var host = document.getElementById("msg");
    host.textContent = "";
    if (!text) return;
    var p = document.createElement("p");
    p.className = "msg " + (kind || "err");
    p.setAttribute("role", "alert");
    // textContent, not innerHTML: server messages are trusted here, but the
    // next person to render a user-supplied string should not have to notice
    // that the escaping was missing.
    p.textContent = text;
    host.appendChild(p);
  }

  function step(n) {
    document.getElementById("step1").className = "step" + (n === 1 ? " on" : "");
    document.getElementById("step2").className = "step" + (n === 2 ? " on" : "");
    document.getElementById("d2").className = "dot" + (n === 2 ? " on" : "");
  }

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error((data.error && data.error.message) || "Failed");
        return data;
      });
    });
  }

  // ── Step 1: password ──────────────────────────────────────────────────────
  var next = document.getElementById("next");
  function submitPassword() {
    var password = document.getElementById("password").value;
    if (!password) { show("Enter the password."); return; }
    next.disabled = true;
    show(null);
    post("/login", { password: password })
      .then(function (data) {
        // In development the server may skip the wallet step entirely and
        // return a session outright (ADMIN_DEV_SKIP_WALLET). It refuses to
        // boot with that set outside development, so this branch cannot be
        // reached by a deployed console.
        if (data.walletSkipped) {
          window.location.href = "/";
          return;
        }
        challengeId = data.challengeId;
        challengeXdr = data.transactionXdr;
        challengeNetwork = data.networkPassphrase;
        document.getElementById("challenge").value = data.message;
        // hidePassword is a hoisted declaration below, so it is defined by
        // the time this callback runs.
        hidePassword();
        step(2);
        show("Password accepted. Now connect the authorised wallet.", "info");
      })
      .catch(function (err) { show(err.message); })
      .then(function () { next.disabled = false; });
  }
  next.addEventListener("click", submitPassword);
  document.getElementById("password").addEventListener("keydown", function (e) {
    if (e.key === "Enter") submitPassword();
  });

  // ── Show / hide the password ──────────────────────────────────────────────
  //
  // Typing a password blind is how a correct one gets reported as wrong, and
  // on this form a wrong one costs an attempt against a five-try lockout.
  //
  // Toggling type between "password" and "text" is what browsers and password
  // managers expect, so autofill keeps working. The aria-pressed attribute
  // carries the state for a screen reader, which cannot see that the dots
  // became letters.
  var toggle = document.getElementById("toggle");
  var field = document.getElementById("password");
  toggle.addEventListener("click", function () {
    var revealed = field.type === "text";
    field.type = revealed ? "password" : "text";
    toggle.textContent = revealed ? "Show" : "Hide";
    toggle.setAttribute("aria-pressed", String(!revealed));
    var label = revealed ? "Show password" : "Hide password";
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("title", label);
    // Return focus to the field so typing continues where it left off rather
    // than stranding the caret on the button.
    field.focus();
  });

  // Re-hide once the password has been accepted. Step two can sit on screen
  // for a while as a wallet is opened, and leaving the password legible for
  // that whole time is exactly when someone walks past.
  function hidePassword() {
    if (field.type !== "text") return;
    field.type = "password";
    toggle.textContent = "Show";
    toggle.setAttribute("aria-pressed", "false");
    toggle.setAttribute("aria-label", "Show password");
    toggle.setAttribute("title", "Show password");
  }

  // ── Step 2: wallet signature ──────────────────────────────────────────────
  function verify(signedTransactionXdr) {
    return post("/login/verify", {
      challengeId: challengeId,
      signedTransactionXdr: signedTransactionXdr
    }).then(function () { window.location.href = "/"; });
  }

  // ── Step 2: connect a wallet ──────────────────────────────────────────────
  //
  // The same Stellar Wallets Kit modal the main site uses, bundled and served
  // from this origin. Every wallet it lists can sign a transaction, which is
  // why the challenge is a transaction rather than a plain message: signMessage
  // support is uneven, and hardware wallets generally lack it entirely.
  var challengeXdr = null;
  var challengeNetwork = null;

  function signWithWallet(button) {
    if (!window.adminWallet) {
      show("The wallet module did not load. Use “Sign another way” below.");
      document.getElementById("pasteWrap").style.display = "block";
      return;
    }
    button.disabled = true;
    show(null);

    window.adminWallet
      .connectAndSign(challengeXdr, challengeNetwork)
      .then(function (result) {
        // Checked here only so a mistake is legible. The server verifies the
        // signature against the configured key regardless, so this cannot
        // grant access — it turns "not the authorised wallet" into something
        // the operator can act on.
        if (EXPECTED && result.address && result.address !== EXPECTED) {
          throw new Error(
            "That is a different wallet. Reconnect using the authorised " +
            "account and try again."
          );
        }
        return verify(result.signedTransactionXdr);
      })
      .catch(function (err) {
        show(err.message || "Signing was cancelled.");
        button.disabled = false;
      });
  }

  var EXPECTED = document.getElementById("expectedWallet").textContent.trim();
  document.getElementById("connect").addEventListener("click", function () {
    signWithWallet(this);
  });

  document.getElementById("manual").addEventListener("click", function () {
    document.getElementById("pasteWrap").style.display = "block";
    document.getElementById("signature").focus();
  });

  document.getElementById("submitSig").addEventListener("click", function () {
    var btn = this;
    var sig = document.getElementById("signature").value.trim();
    if (!sig) { show("Paste the signed transaction first."); return; }
    btn.disabled = true;
    show(null);
    verify(sig).catch(function (err) {
      show(err.message);
      btn.disabled = false;
    });
  });
})();
</script>
</body>
</html>`;
}

/**
 * Escape text before it reaches the page.
 *
 * The only interpolated value here is an error message this module authors, so
 * nothing untrusted currently flows in. It is escaped anyway: the next person
 * to add a message from a request parameter should not have to notice that the
 * escaping was missing.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
