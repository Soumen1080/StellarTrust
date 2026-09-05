/**
 * The sign-in page.
 *
 * Server-rendered plain HTML rather than a React app. The console is one
 * operator on one screen; a build pipeline, a bundler and a hydration step
 * would be three more things to deploy and keep current for no gain the
 * operator would notice.
 *
 * Deliberately says nothing about what this is. A page reading "StellarTrust
 * Admin — production" tells anyone who stumbles onto it exactly what they have
 * found and what it is worth attacking.
 */
export function loginPage(error: string | null): string {
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
    background: #0b0e11; color: #eaecef;
    font: 15px/1.5 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  form {
    width: min(360px, calc(100vw - 32px));
    background: #1e2329; border: 1px solid #2b3139; border-radius: 12px;
    padding: 32px;
  }
  h1 { margin: 0 0 4px; font-size: 18px; }
  p.sub { margin: 0 0 24px; font-size: 13px; color: #707a8a; }
  label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 8px; }
  input {
    width: 100%; padding: 10px 12px; border-radius: 6px;
    border: 1px solid #2b3139; background: #0b0e11; color: #eaecef;
    font: inherit;
  }
  input:focus { outline: 2px solid #fcd535; outline-offset: 1px; }
  button {
    width: 100%; margin-top: 20px; padding: 11px; border: 0; border-radius: 6px;
    background: #fcd535; color: #181a20; font: inherit; font-weight: 600;
    cursor: pointer;
  }
  button:hover { background: #f0b90b; }
  .error {
    margin: 0 0 16px; padding: 10px 12px; border-radius: 6px; font-size: 13px;
    background: rgba(246,70,93,.1); border: 1px solid rgba(246,70,93,.3);
    color: #f6465d;
  }
</style>
</head>
<body>
<form method="post" action="/login">
  <h1>Sign in</h1>
  <p class="sub">Restricted access.</p>
  ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password"
         autofocus required>
  <button type="submit">Continue</button>
</form>
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
