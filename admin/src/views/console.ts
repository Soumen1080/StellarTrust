/**
 * The console page.
 *
 * One self-contained HTML document with an inline script that talks to
 * `/api/*`. No bundler, no framework, no external requests — which is also why
 * the CSP in `app.ts` can be as tight as it is.
 *
 * Everything the script renders goes through `text()`, which sets
 * `textContent` rather than `innerHTML`. This console displays user-supplied
 * strings (asset descriptions, rejection reasons, Stellar addresses), and
 * `innerHTML` on any of those is a stored-XSS hole in the one application that
 * can approve KYC.
 */
export function consolePage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Console</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #0b0e11; color: #eaecef;
    font: 14px/1.5 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  header {
    display: flex; align-items: center; justify-content: space-between;
    gap: 16px; padding: 14px 24px; border-bottom: 1px solid #2b3139;
    position: sticky; top: 0; background: #0b0e11; z-index: 10;
  }
  h1 { margin: 0; font-size: 15px; font-weight: 600; }
  nav { display: flex; gap: 4px; flex-wrap: wrap; }
  nav button {
    padding: 6px 12px; border: 0; border-radius: 6px; background: transparent;
    color: #929aa5; font: inherit; font-weight: 500; cursor: pointer;
  }
  nav button[aria-current="true"] { background: #2b3139; color: #fff; }
  main { padding: 24px; max-width: 1400px; margin: 0 auto; }
  .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit,minmax(200px,1fr)); }
  .card { background: #1e2329; border: 1px solid #2b3139; border-radius: 10px; padding: 16px; }
  .card h3 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase;
             letter-spacing: .06em; color: #929aa5; font-weight: 500; }
  .card .v { font: 600 22px/1.2 "IBM Plex Mono", ui-monospace, monospace; }
  section.panel { margin-top: 24px; background: #1e2329; border: 1px solid #2b3139;
                  border-radius: 10px; overflow: hidden; }
  section.panel > h2 { margin: 0; padding: 12px 16px; font-size: 14px;
                       border-bottom: 1px solid #2b3139; }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; min-width: 640px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase;
       letter-spacing: .05em; color: #929aa5; font-weight: 500;
       padding: 10px 16px; border-bottom: 1px solid #2b3139; }
  td { padding: 10px 16px; border-bottom: 1px solid rgba(43,49,57,.5);
       vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  .mono { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 12px; }
  .muted { color: #707a8a; }
  .empty { padding: 24px; text-align: center; color: #707a8a; }
  input, select {
    padding: 7px 10px; border-radius: 6px; border: 1px solid #2b3139;
    background: #0b0e11; color: #eaecef; font: inherit; font-size: 13px;
  }
  .act { display: flex; gap: 6px; margin-top: 6px; }
  .act button {
    padding: 6px 12px; border: 0; border-radius: 6px; font: inherit;
    font-size: 12px; font-weight: 600; cursor: pointer;
  }
  .ok  { background: rgba(14,203,129,.15); color: #0ecb81; }
  .bad { background: rgba(246,70,93,.15); color: #f6465d; }
  button[disabled] { opacity: .4; cursor: not-allowed; }
  .banner { padding: 10px 14px; border-radius: 6px; margin-bottom: 16px; font-size: 13px; }
  .banner.err { background: rgba(246,70,93,.1); border: 1px solid rgba(246,70,93,.3); color: #f6465d; }
  .banner.good { background: rgba(14,203,129,.1); border: 1px solid rgba(14,203,129,.3); color: #0ecb81; }
  .logout { padding: 6px 12px; border: 1px solid #2b3139; border-radius: 6px;
            background: transparent; color: #929aa5; font: inherit; cursor: pointer; }
</style>
</head>
<body>
<header>
  <h1>Console</h1>
  <nav id="tabs"></nav>
  <form method="post" action="/logout"><button class="logout" type="submit">Sign out</button></form>
</header>
<main>
  <div id="banner"></div>
  <div id="view"><p class="empty">Loading…</p></div>
</main>
<script>
(function () {
  "use strict";

  var TABS = [
    { id: "overview", label: "Overview" },
    { id: "queues",   label: "Queues" },
    { id: "policy",   label: "Policy" },
    { id: "audit",    label: "Audit" }
  ];
  var active = "overview";
  var cache = {};

  // Every value from the server goes through here. textContent, never
  // innerHTML: this console renders asset descriptions and rejection reasons
  // written by users, and innerHTML on those is stored XSS in the one app that
  // can approve KYC.
  function text(tag, value, className) {
    var el = document.createElement(tag);
    el.textContent = value === null || value === undefined ? "—" : String(value);
    if (className) el.className = className;
    return el;
  }

  function banner(message, kind) {
    var host = document.getElementById("banner");
    host.textContent = "";
    if (!message) return;
    var el = text("div", message, "banner " + (kind || "err"));
    host.appendChild(el);
  }

  function api(path, options) {
    return fetch("/api" + path, Object.assign({ credentials: "same-origin" }, options))
      .then(function (res) {
        if (res.status === 401) { window.location.href = "/login"; return null; }
        return res.json().then(function (body) {
          if (!res.ok) throw new Error((body.error && body.error.message) || "Request failed");
          return body;
        });
      });
  }

  function table(columns, rows, emptyMessage) {
    if (!rows.length) return text("p", emptyMessage, "empty");
    var wrap = document.createElement("div");
    wrap.className = "scroll";
    var t = document.createElement("table");
    var thead = document.createElement("thead");
    var hr = document.createElement("tr");
    columns.forEach(function (c) { hr.appendChild(text("th", c)); });
    thead.appendChild(hr);
    t.appendChild(thead);
    var tbody = document.createElement("tbody");
    rows.forEach(function (cells) {
      var tr = document.createElement("tr");
      cells.forEach(function (cell) {
        var td = document.createElement("td");
        if (cell instanceof Node) td.appendChild(cell);
        else td.textContent = cell === null || cell === undefined ? "—" : String(cell);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    t.appendChild(tbody);
    wrap.appendChild(t);
    return wrap;
  }

  function panel(title, body) {
    var s = document.createElement("section");
    s.className = "panel";
    s.appendChild(text("h2", title));
    s.appendChild(body);
    return s;
  }

  function money(amounts) {
    var keys = Object.keys(amounts || {});
    if (!keys.length) return "—";
    // Per currency, never summed: a cross-currency total needs an FX rate this
    // console does not have.
    return keys.map(function (c) { return amounts[c] + " " + c; }).join("  ·  ");
  }

  function shortId(v) {
    if (!v) return "—";
    return v.length > 16 ? v.slice(0, 6) + "…" + v.slice(-6) : v;
  }

  // ── Views ────────────────────────────────────────────────────────────────

  function renderOverview(data) {
    var view = document.getElementById("view");
    view.textContent = "";
    var m = data.metrics;

    var grid = document.createElement("div");
    grid.className = "grid";
    [
      ["Total value locked", money(m.totalValueLocked)],
      ["Capital deployed", money(m.capitalDeployed)],
      ["Default rate", (m.defaultRateBps / 100).toFixed(2) + "%"],
      ["Dispute rate", (m.disputeRateBps / 100).toFixed(2) + "%"],
      ["Open disputes", m.openDisputes],
      ["Overdue positions", m.overduePositions],
      ["Orders", m.ordersTotal],
      ["Avg days to collect", m.averageDaysToCollect === null ? "—" : m.averageDaysToCollect]
    ].forEach(function (pair) {
      var card = document.createElement("div");
      card.className = "card";
      card.appendChild(text("h3", pair[0]));
      card.appendChild(text("div", pair[1], "v"));
      grid.appendChild(card);
    });
    view.appendChild(grid);

    view.appendChild(panel("Tokenizations", table(
      ["Position", "Status", "Face value", "Sold", "Maturity"],
      data.tokenizations.map(function (t) {
        return [
          text("span", shortId(t.id), "mono"),
          t.status,
          text("span", t.face_value_amount + " " + t.face_value_currency, "mono"),
          text("span", t.units_sold + " / " + t.total_units, "mono"),
          text("span", t.maturity_date ? t.maturity_date.slice(0, 10) : "—", "mono")
        ];
      }),
      "No tokenizations yet."
    )));

    view.appendChild(panel("Disputes", table(
      ["Dispute", "Order", "Status", "Opened"],
      data.disputes.map(function (d) {
        return [
          text("span", shortId(d.id), "mono"),
          text("span", shortId(d.order_id), "mono"),
          d.status,
          text("span", String(d.created_at).slice(0, 10), "mono")
        ];
      }),
      "No disputes."
    )));
  }

  function decisionCell(id, buttons, placeholder) {
    var wrap = document.createElement("div");
    var input = document.createElement("input");
    input.placeholder = placeholder;
    input.style.width = "220px";
    wrap.appendChild(input);
    var row = document.createElement("div");
    row.className = "act";
    buttons.forEach(function (b) {
      var btn = document.createElement("button");
      btn.textContent = b.label;
      btn.className = b.kind;
      btn.addEventListener("click", function () {
        var reason = input.value.trim();
        if (b.needsReason && reason.length < 3) {
          banner("A reason of at least 3 characters is required.");
          return;
        }
        row.querySelectorAll("button").forEach(function (x) { x.disabled = true; });
        b.run(reason)
          .then(function () {
            banner("Recorded.", "good");
            load(true);
          })
          .catch(function (err) {
            banner(err.message);
            row.querySelectorAll("button").forEach(function (x) { x.disabled = false; });
          });
      });
      row.appendChild(btn);
    });
    wrap.appendChild(row);
    return wrap;
  }

  function renderQueues(data) {
    var view = document.getElementById("view");
    view.textContent = "";

    view.appendChild(panel("KYC review queue", table(
      ["Applicant", "Risk", "Confidence", "Waiting since", "Decision"],
      data.kyc.map(function (r) {
        return [
          text("span", shortId(r.user_id), "mono"),
          r.risk_score === null ? "—" : Math.round(r.risk_score * 100) + "%",
          r.confidence === null ? "—" : Math.round(r.confidence * 100) + "%",
          text("span", String(r.created_at).slice(0, 10), "mono"),
          decisionCell(r.id, [
            { label: "Approve", kind: "ok", needsReason: true, run: function (reason) {
                return api("/kyc/" + r.id, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ decision: "approve", reason: reason })
                }); } },
            { label: "Reject", kind: "bad", needsReason: true, run: function (reason) {
                return api("/kyc/" + r.id, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ decision: "reject", reason: reason })
                }); } }
          ], "Reason (required)")
        ];
      }),
      "Nothing waiting on a KYC decision."
    )));

    view.appendChild(panel("Asset verification queue", table(
      ["Asset", "Type", "Valuation", "Decision"],
      data.assets.map(function (a) {
        var who = document.createElement("div");
        who.appendChild(text("div", a.description));
        who.appendChild(text("div", a.asset_ref, "mono muted"));
        return [
          who,
          a.asset_type,
          text("span", a.valuation_amount + " " + a.valuation_currency, "mono"),
          decisionCell(a.id, [
            { label: "Verify", kind: "ok", needsReason: false, run: function (note) {
                return api("/assets/" + a.id, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ decision: "verify", note: note || undefined })
                }); } },
            { label: "Reject", kind: "bad", needsReason: true, run: function (note) {
                return api("/assets/" + a.id, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ decision: "reject", note: note })
                }); } }
          ], "Note (required to reject)")
        ];
      }),
      "Nothing waiting on an asset decision."
    )));

    var held = data.treasury.filter(function (m) {
      return m.direction === "withdrawal" && m.status === "pending";
    });
    var note = document.createElement("div");
    note.appendChild(table(
      ["User", "Amount", "Destination", "Action"],
      held.map(function (m) {
        return [
          text("span", shortId(m.user_id), "mono"),
          text("span", m.amount + " " + m.currency, "mono"),
          text("span", shortId(m.counterparty_address), "mono"),
          decisionCell(m.id, [
            { label: "Refuse", kind: "bad", needsReason: true, run: function (reason) {
                return api("/withdrawals/" + m.id + "/reject", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ reason: reason })
                }); } }
          ], "Reason (required)")
        ];
      }),
      "No withdrawals waiting."
    ));
    // Said on the screen rather than only in the code: an operator looking for
    // an Approve button needs to know why there isn't one.
    note.appendChild(text("p",
      "This console can refuse a withdrawal but never send one — approving " +
      "submits a real Stellar payment, which needs the signing key that lives " +
      "only on the backend.", "empty"));
    view.appendChild(panel("Withdrawals awaiting a decision", note));

    view.appendChild(panel("Treasury movements", table(
      ["Direction", "User", "Amount", "Status", "When"],
      data.treasury.map(function (m) {
        return [
          m.direction,
          text("span", shortId(m.user_id), "mono"),
          text("span", m.amount + " " + m.currency, "mono"),
          m.status,
          text("span", String(m.created_at).slice(0, 10), "mono")
        ];
      }),
      "No movements yet."
    )));
  }

  function renderPolicy(data) {
    var view = document.getElementById("view");
    view.textContent = "";

    var intro = document.createElement("div");
    intro.className = "banner good";
    intro.textContent =
      "AI is advisory in every mode. Automatic means the deterministic policy " +
      "may conclude without queueing a person — a sanctions hit, a failed " +
      "provider check, or an amount above the ceiling still reaches someone.";
    view.appendChild(intro);

    data.policies.forEach(function (p) {
      var body = document.createElement("div");
      body.style.padding = "16px";

      var row = document.createElement("div");
      row.style.cssText = "display:flex;gap:12px;flex-wrap:wrap;align-items:end";

      function field(label, node) {
        var w = document.createElement("label");
        w.style.cssText = "display:block;font-size:12px;color:#929aa5";
        w.appendChild(text("div", label));
        w.appendChild(node);
        return w;
      }

      var mode = document.createElement("select");
      [["auto","Automatic"],["ai","AI-advised"],["human","Human review"]]
        .forEach(function (o) {
          var opt = document.createElement("option");
          opt.value = o[0]; opt.textContent = o[1];
          if (p.mode === o[0]) opt.selected = true;
          mode.appendChild(opt);
        });

      function num(value) {
        var i = document.createElement("input");
        i.type = "number"; i.step = "0.01"; i.min = "0"; i.max = "100";
        i.value = (value / 100).toString();
        i.style.width = "90px";
        return i;
      }
      var approve = num(p.approve_max_risk_bps);
      var reject = num(p.reject_min_risk_bps);
      var conf = num(p.min_confidence_bps);
      var amount = document.createElement("input");
      amount.value = p.human_review_above_amount;
      amount.style.width = "140px";

      row.appendChild(field("Mode", mode));
      row.appendChild(field("Approve at or below %", approve));
      row.appendChild(field("Reject at or above %", reject));
      row.appendChild(field("Min confidence %", conf));
      row.appendChild(field("Always review above (minor units)", amount));

      var save = document.createElement("button");
      save.textContent = "Save";
      save.className = "ok";
      save.style.cssText = "padding:8px 16px;border:0;border-radius:6px;font:inherit;font-weight:600;cursor:pointer";
      save.addEventListener("click", function () {
        save.disabled = true;
        api("/policies/" + p.domain, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: mode.value,
            approveMaxRiskBps: Math.round(parseFloat(approve.value) * 100),
            rejectMinRiskBps: Math.round(parseFloat(reject.value) * 100),
            minConfidenceBps: Math.round(parseFloat(conf.value) * 100),
            humanReviewAboveAmount: amount.value.replace(/[^0-9]/g, "") || "0"
          })
        })
          .then(function () { banner("Policy saved. It applies to the next submission.", "good"); load(true); })
          .catch(function (err) { banner(err.message); save.disabled = false; });
      });
      row.appendChild(save);
      body.appendChild(row);

      var label = p.domain === "kyc" ? "Customer onboarding (KYC)" : "Asset verification";
      view.appendChild(panel(label, body));
    });
  }

  function renderAudit(data) {
    var view = document.getElementById("view");
    view.textContent = "";
    view.appendChild(panel("Audit trail", table(
      ["When", "Actor", "Action", "Entity"],
      data.events.map(function (e) {
        return [
          text("span", String(e.created_at).replace("T", " ").slice(0, 16), "mono"),
          text("span", e.actor, "mono"),
          text("span", e.action, "mono"),
          text("span", e.entity + " " + shortId(e.entity_id), "mono muted")
        ];
      }),
      "Nothing recorded yet."
    )));
  }

  var ENDPOINT = {
    overview: "/overview", queues: "/queues",
    policy: "/policies", audit: "/audit"
  };
  var RENDER = {
    overview: renderOverview, queues: renderQueues,
    policy: renderPolicy, audit: renderAudit
  };

  function load(force) {
    if (!force && cache[active]) { RENDER[active](cache[active]); return; }
    document.getElementById("view").textContent = "";
    document.getElementById("view").appendChild(text("p", "Loading…", "empty"));
    api(ENDPOINT[active])
      .then(function (data) {
        if (!data) return;
        cache[active] = data;
        RENDER[active](data);
      })
      .catch(function (err) {
        banner(err.message);
        document.getElementById("view").textContent = "";
      });
  }

  var nav = document.getElementById("tabs");
  TABS.forEach(function (t) {
    var b = document.createElement("button");
    b.textContent = t.label;
    b.setAttribute("aria-current", String(t.id === active));
    b.addEventListener("click", function () {
      active = t.id;
      banner(null);
      nav.querySelectorAll("button").forEach(function (x) {
        x.setAttribute("aria-current", String(x.textContent === t.label));
      });
      load(false);
    });
    nav.appendChild(b);
  });

  load(false);
})();
</script>
</body>
</html>`;
}
