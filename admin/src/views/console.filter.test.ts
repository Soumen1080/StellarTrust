/**
 * The console's row filter.
 *
 * Driven against the real page rather than a copy of the logic: the filter is
 * inline browser script inside a template string, so the only honest way to
 * test it is to run that script the way a browser does and type into the box.
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { consolePage } from "./console.js";

/**
 * Mount the console page and execute its inline script.
 *
 * jsdom will not run a <script> injected via innerHTML, so the script body is
 * lifted out and evaluated — the same code, the same DOM.
 */
function mountConsole(): void {
  const html = consolePage();
  const body = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));
  const scriptStart = body.indexOf("<script>");
  document.body.innerHTML = body.slice(0, scriptStart);

  // The page fetches on load. These tests are about filtering rows that are
  // already rendered, so the response only has to be well-formed.
  vi.stubGlobal("fetch", () =>
    Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) }),
  );
  new Function(
    body.slice(scriptStart + "<script>".length, body.lastIndexOf("</script>")),
  )();
}

/** Render rows the way the console's own `table()` helper lays them out. */
function seedRows(rows: string[][]): void {
  const view = document.getElementById("view")!;
  view.textContent = "";
  const panel = document.createElement("section");
  panel.className = "panel";
  const table = document.createElement("table");
  const tbody = document.createElement("tbody");
  for (const cells of rows) {
    const tr = document.createElement("tr");
    for (const cell of cells) {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  panel.appendChild(table);
  view.appendChild(panel);
}

function type(value: string): void {
  const input = document.getElementById("search") as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function visibleRows(): string[] {
  return Array.from(document.querySelectorAll("#view tbody tr"))
    .filter((tr) => !tr.classList.contains("hidden-row"))
    .map((tr) => tr.textContent ?? "");
}

describe("filtering the console by username", () => {
  beforeEach(() => {
    mountConsole();
    seedRows([
      ["@sam123", "500 USDC", "deposited"],
      ["@user_50527a8bfb16", "200 XLM", "released"],
      ["@ada_lovelace", "75 USDC", "released"],
    ]);
  });

  it("shows every row when the box is empty", () => {
    expect(visibleRows()).toHaveLength(3);
  });

  it("narrows to the matching username", () => {
    type("sam123");
    const visible = visibleRows();
    expect(visible).toHaveLength(1);
    expect(visible[0]).toContain("@sam123");
  });

  it("ignores case, so the operator need not match the stored form", () => {
    type("SAM123");
    expect(visibleRows()).toHaveLength(1);
  });

  it("matches a partial handle", () => {
    type("ada");
    expect(visibleRows()).toHaveLength(1);
  });

  it("filters on any column, not only the username", () => {
    type("released");
    expect(visibleRows()).toHaveLength(2);
  });

  it("reports what is hidden, so a filtered table is not read as missing data", () => {
    type("sam123");
    expect(document.getElementById("searchCount")!.textContent).toBe(
      "1 of 3 row(s)",
    );
  });

  it("says so when nothing matches", () => {
    type("nobody-by-that-name");
    expect(visibleRows()).toHaveLength(0);
    expect(document.querySelector("#view .no-match")).not.toBeNull();
  });

  it("restores every row when cleared", () => {
    type("sam123");
    type("");
    expect(visibleRows()).toHaveLength(3);
    expect(document.getElementById("searchCount")!.textContent).toBe("");
  });

  it("clears on Escape", () => {
    type("sam123");
    const input = document.getElementById("search") as HTMLInputElement;
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(input.value).toBe("");
    expect(visibleRows()).toHaveLength(3);
  });
});
