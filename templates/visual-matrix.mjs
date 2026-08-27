// scripts/visual-matrix.mjs
//
// Visual matrix — ship-gate machinery.
//
// Walks every surface × meaningful state × viewport via Playwright + a
// virtual WebAuthn authenticator (so passkey flows work headlessly),
// producing:
//   - Individual PNG per (surface, state, viewport) at full resolution
//   - HTML contact sheet per viewport (loads the shots as a labeled
//     mosaic) so the reviewer can scan all cells in one page
//
// Also emits an overlap report per viewport: for each shot, the set of
// visible labeled elements (input/select/button/textarea/label) and
// whether any two intersect. The `no element overlap across the visual
// matrix` adversity test runs the same walk and asserts zero
// intersections — this script's overlap report exists so the human
// reviewer can see WHAT overlapped WHERE.
//
// The matrix covers UI states AND DATA STATES: a state that only exists
// when data exists is a state nobody looks at unless the matrix creates
// the data. Data-dependent cells seed the data via the API.
//
// Also runs an iOS Simulator pass for URL-reachable surfaces — mobile
// Safari with real browser chrome catches the class of bug headless
// Chromium is structurally blind to (`100dvh` overflow, aspect-ratio
// compounding, flex intrinsic-min-content on shared parents).
//
// Requires a local wrangler dev server on http://localhost:8787.
//
// Usage: node scripts/visual-matrix.mjs

import { chromium } from "playwright";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const BASE = "http://localhost:8787";
const OUT_ROOT = "tmp/visual-matrix";

// Pin your iOS Simulator UDID(s) here. Find with:
//   xcrun simctl list devices | grep 'iPhone'
const SIMULATOR_UDIDS = [
  // "{{YOUR_IPHONE_UDID}}", // e.g. "3C3CF59F-CC82-47B0-A139-0F14D6AF6165"
];

const VIEWPORTS = [
  { name: "390x844", width: 390, height: 844 },   // iPhone 14 Pro
  { name: "430x932", width: 430, height: 932 },   // iPhone 15 Pro Max
  { name: "1440x900", width: 1440, height: 900 }, // desktop
];

async function preflight() {
  try {
    const r = await fetch(`${BASE}/api/health`);
    if (!r.ok) throw new Error(`unhealthy: ${r.status}`);
  } catch (e) {
    console.error(`\n[visual-matrix] cannot reach ${BASE}/api/health.`);
    console.error(`Run 'npx wrangler dev --local --persist-to=.wrangler/state --port 8787' in another shell, then retry.\n`);
    process.exit(2);
  }
}

async function addAuthenticator(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
  return cdp;
}

async function register(page, handle) {
  await page.goto(`${BASE}/`);
  await page.getByPlaceholder("your_handle").fill(handle);
  await page.waitForTimeout(500);
  // Match the app's actual button-label pattern. The "Working" branch
  // covers the in-flight state.
  await page.getByRole("button", { name: /^(Sign in( as @|.*sign up$)|Sign up as @|Working)/ }).click();
  await page.getByText(`@${handle}`).waitFor({ timeout: 15000 });
}

async function screenshot(page, dir, key) {
  const path = join(dir, `${key}.png`);
  await page.screenshot({ path, fullPage: false });
  return path;
}

async function collectOverlaps(page) {
  return await page.evaluate(() => {
    const sel = "input, select, button, textarea, label";
    const nodes = Array.from(document.querySelectorAll(sel));
    // Modal overlays cover content by design; only same-layer pairs count.
    const MODAL_SELECTOR = ".menu-sheet, .menu-backdrop, [role='dialog'], [role='alertdialog']";
    const boxes = [];
    for (const el of nodes) {
      if (el.getAttribute("aria-hidden") === "true") continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      if (r.right < 0 || r.left > window.innerWidth) continue;
      // Skip elements that are ANCESTORS of another labeled element
      // (a <label> that wraps an <input> naturally shares bounding area;
      // that's not "overlap" — only sibling-level collisions count).
      const isAncestorOfOther = nodes.some((o) => o !== el && el.contains(o));
      const modal = Boolean(el.closest(MODAL_SELECTOR));
      const short = (el.tagName + (el.getAttribute("class") ? "." + el.getAttribute("class").split(" ")[0] : "")).slice(0, 60);
      boxes.push({ tag: short, ancestor: isAncestorOfOther, modal, x: r.x, y: r.y, w: r.width, h: r.height });
    }
    const overlaps = [];
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].ancestor) continue;
      for (let j = i + 1; j < boxes.length; j++) {
        if (boxes[j].ancestor) continue;
        const a = boxes[i], b = boxes[j];
        // Skip modal-over-page pairs (menu-sheet above dashboard chrome
        // is by design, not a layout regression).
        if (a.modal !== b.modal) continue;
        const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        if (ix >= 3 && iy >= 3) overlaps.push({ a: a.tag, b: b.tag, iw: ix, ih: iy });
      }
    }
    return { boxes: boxes.length, overlaps };
  });
}

// ----- surface × state walk ------------------------------------------
//
// Each state entry: { key, label, mount(page, ctx) }
// ctx carries persistent state (users, tokens, ids).

async function unauth(page, path) {
  const ctx = await page.context();
  await ctx.clearCookies();
  await page.goto(`${BASE}${path}`);
}

async function stateLanding(page) {
  await unauth(page, "/");
  await page.waitForTimeout(700);
}

async function stateDashboardRest(page) {
  await page.goto(`${BASE}/`);
  await page.waitForSelector(".dashboard", { timeout: 8000 });
  await page.waitForTimeout(300);
}

// ---- data-seeded cells (adapt to your API surface) ----

async function ensureOutgoingInvitation(ctx) {
  // Idempotent (server dedupes per fromId/toId): safe to call whenever a
  // pending outgoing invitation is required as data setup for a cell.
  const owner = ctx.alice.page;
  await owner.evaluate(async (recipientId) => {
    await fetch("/api/invitations", {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipientId }),
    });
  }, ctx.bob.id);
}

async function stateDashboardOutgoingInvitation(page, ctx) {
  await ensureOutgoingInvitation(ctx);
  await stateDashboardRest(page);
}

async function stateDashboardIncomingInvitation(page, ctx) {
  // Screenshot BOB's page — alice invited him, his home shows the
  // incoming band.
  await ensureOutgoingInvitation(ctx);
  const bob = ctx.bob.page;
  await bob.goto(`${BASE}/`);
  await bob.waitForSelector(".dashboard", { timeout: 8000 });
  await bob.waitForTimeout(300);
  return bob; // signal runner to screenshot bob's page instead
}

async function stateDashboardZeroFriends(page, ctx) {
  // Fresh user with no relationships — proves the empty-state copy.
  const zPage = ctx.zeroFriends.page;
  await zPage.goto(`${BASE}/`);
  await zPage.waitForSelector(".dashboard", { timeout: 8000 });
  await zPage.waitForTimeout(300);
  return zPage;
}

// ----- runner --------------------------------------------------------

async function makeContext(browser) {
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const zeroCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  const zero = await zeroCtx.newPage();
  await addAuthenticator(alice);
  await addAuthenticator(bob);
  await addAuthenticator(zero);
  const suffix = Date.now().toString(36).slice(-6);
  const aH = `mata_${suffix}`;
  const bH = `matb_${suffix}`;
  const zH = `matz_${suffix}`;
  await register(alice, aH);
  await register(bob, bH);
  await register(zero, zH);

  // Establish the alice ↔ bob relationship (adapt to your API — friend
  // request / follow / add-member).
  // TODO: fill in the specific handshake for your app.

  // Pull IDs so the seed helpers can hit the API without UI selectors.
  const [aliceInfo, bobInfo] = await Promise.all([
    alice.evaluate(async () => (await (await fetch("/api/me")).json()).user),
    bob.evaluate(async () => (await (await fetch("/api/me")).json()).user),
  ]);
  return {
    browser,
    alice: { page: alice, handle: aH, id: aliceInfo.id, ctx: aliceCtx },
    bob:   { page: bob,   handle: bH, id: bobInfo.id,   ctx: bobCtx },
    zeroFriends: { page: zero, handle: zH, ctx: zeroCtx },
  };
}

// STATE ISOLATION CONTRACT (mandatory — Codex audit gap #16):
// Every cell declares { seed, cleanup, expected } even if some are no-op.
// Runner validates: after seed(), the expected state holds; after
// cleanup(), the ctx is restored to a known clean baseline. Screenshots
// captured from polluted state hide the exact empty/rest/terminal states
// they claim to prove.
//
// Cells are named by the STATE they capture, not the sequence they run in.
// If two cells conflict, one MUST explicitly cleanup or the runner
// spawns a fresh context per cell.
//
// Cell shape:
//   {
//     group: "unauth" | "alice" | "bob" | ...,
//     key: "dashboard-outgoing-invite",
//     label: "dashboard / outgoing invite",
//     seed: async (ctx) => { /* create the data state this cell needs */ },
//     mount: async (page, ctx) => { /* navigate + wait for render */
//                                    /* return alternate Page to screenshot it instead */ },
//     expected: async (page) => { /* assert the state is what we think — fail loud */ },
//     cleanup: async (ctx) => { /* tear down data state so next cell starts clean */ },
//   }
//
// For appendix compatibility with the reference implementation, the run()
// function below still supports the legacy shape (`run(page, ctx)`).
const CELLS = [
  { group: "unauth", key: "landing-rest",              label: "landing / rest",              run: stateLanding },
  { group: "alice",  key: "dashboard-rest",            label: "dashboard / rest",            run: stateDashboardRest },
  { group: "alice",  key: "dashboard-outgoing-invite", label: "dashboard / outgoing invite", run: stateDashboardOutgoingInvitation },
  { group: "alice",  key: "dashboard-incoming-invite", label: "bob's dashboard / incoming invite", run: stateDashboardIncomingInvitation },
  { group: "alice",  key: "dashboard-zero-friends",    label: "dashboard / zero relationships (empty state)", run: stateDashboardZeroFriends },
  // TODO: add cells for every state you want gated by the ship-gate.
];

async function runViewport(browser, viewport) {
  const dir = join(OUT_ROOT, viewport.name);
  if (existsSync(dir)) await rm(dir, { recursive: true });
  await mkdir(dir, { recursive: true });

  const ctx = await makeContext(browser);
  for (const pg of [ctx.alice.page, ctx.bob.page, ctx.zeroFriends.page]) {
    await pg.setViewportSize({ width: viewport.width, height: viewport.height });
  }

  const unauthCtx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const unauthPage = await unauthCtx.newPage();

  const results = [];
  for (const cell of CELLS) {
    try {
      const defaultPage = cell.group === "unauth" ? unauthPage : ctx.alice.page;
      const returned = await cell.run(defaultPage, ctx);
      const targetPage = returned && typeof returned.screenshot === "function" ? returned : defaultPage;
      const path = await screenshot(targetPage, dir, cell.key);
      const overlaps = await collectOverlaps(targetPage);
      results.push({ ...cell, path, overlaps, ok: true });
      console.log(`  [ok] ${viewport.name} · ${cell.label}  (${overlaps.boxes} boxes, ${overlaps.overlaps.length} overlaps)`);
    } catch (e) {
      results.push({ ...cell, error: String(e).slice(0, 300), ok: false });
      console.log(`  [FAIL] ${viewport.name} · ${cell.label}: ${String(e).slice(0, 200)}`);
    }
  }

  await writeFile(join(dir, "contact-sheet.html"), renderContactSheet(viewport, results));
  const overlapRows = results.filter((r) => r.ok && r.overlaps.overlaps.length)
    .map((r) => ({ cell: r.key, count: r.overlaps.overlaps.length, samples: r.overlaps.overlaps.slice(0, 8) }));
  await writeFile(join(dir, "overlaps.json"), JSON.stringify(overlapRows, null, 2));

  await unauthCtx.close();
  await ctx.alice.ctx.close();
  await ctx.bob.ctx.close();
  await ctx.zeroFriends.ctx.close();
  return { viewport, results };
}

function renderContactSheet(viewport, results) {
  const cells = results.map((r) => {
    const status = r.ok ? (r.overlaps.overlaps.length ? "warn" : "ok") : "fail";
    return `
      <figure class="cell cell-${status}">
        <div class="thumb"><img src="${r.key}.png" alt="${r.label}"></div>
        <figcaption>
          <span class="label">${r.label}</span>
          <span class="meta">${r.ok ? `${r.overlaps.boxes} elements · ${r.overlaps.overlaps.length} overlap${r.overlaps.overlaps.length === 1 ? "" : "s"}` : `FAILED: ${r.error}`}</span>
        </figcaption>
      </figure>
    `;
  }).join("\n");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Visual matrix · ${viewport.name}</title>
<style>
  body { margin: 0; padding: 24px; font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f4efe4; color: #2b2233; }
  h1 { font-family: ui-monospace, monospace; font-weight: 500; font-size: 18px; margin: 0 0 8px; }
  .sub { color: #6b6472; margin-bottom: 24px; font-family: ui-monospace, monospace; font-size: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; }
  .cell { margin: 0; background: #fff; border: 1px solid #d0c8b8; padding: 0; }
  .cell-warn { border-color: #c9a24a; }
  .cell-fail { border-color: #b23a3a; }
  .thumb { background: #ede6d5; }
  .thumb img { display: block; width: 100%; height: auto; }
  figcaption { padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; font-family: ui-monospace, monospace; font-size: 12px; }
  .label { color: #2b2233; }
  .meta { color: #6b6472; font-size: 11px; }
  .cell-warn .meta { color: #7a5a1a; }
  .cell-fail .meta { color: #b23a3a; }
</style></head><body>
<h1>Visual matrix · ${viewport.name}</h1>
<p class="sub">${results.length} cells · ${results.filter((r) => r.ok && r.overlaps.overlaps.length).length} with element overlap · ${results.filter((r) => !r.ok).length} failed to render</p>
<div class="grid">${cells}</div>
</body></html>`;
}

// iOS Simulator capture. Boots the target device (idempotent), points
// mobile Safari at each URL-reachable surface, and grabs the device
// screenshot (browser chrome included). Only URL-reachable states go
// here — deeper interactive states stay headless.
async function runSimulator() {
  if (SIMULATOR_UDIDS.length === 0) {
    console.log(`  [skip] no SIMULATOR_UDIDS configured — edit visual-matrix.mjs to add one`);
    return [];
  }
  const dir = join(OUT_ROOT, "simulator");
  if (existsSync(dir)) await rm(dir, { recursive: true });
  await mkdir(dir, { recursive: true });
  const results = [];
  const URL_STATES = [
    { key: "landing-rest", label: "landing / rest", path: "/" },
    // TODO: add the URL-reachable surfaces you care about (marketing pages,
    //       auth screen, /inspirations, etc.).
  ];
  for (const udid of SIMULATOR_UDIDS) {
    try { await execFileP("xcrun", ["simctl", "boot", udid]); } catch { /* already booted */ }
    await new Promise((r) => setTimeout(r, 800));
    for (const st of URL_STATES) {
      const url = `${BASE}${st.path}`;
      try {
        await execFileP("xcrun", ["simctl", "openurl", udid, url]);
        await new Promise((r) => setTimeout(r, 3500));
        const path = join(dir, `${st.key}-${udid.slice(0, 8)}.png`);
        await execFileP("xcrun", ["simctl", "io", udid, "screenshot", path]);
        results.push({ udid, ...st, path, ok: true });
        console.log(`  [ok] simulator ${udid.slice(0, 8)} · ${st.label}`);
      } catch (e) {
        results.push({ udid, ...st, error: String(e).slice(0, 300), ok: false });
        console.log(`  [FAIL] simulator ${udid.slice(0, 8)} · ${st.label}: ${String(e).slice(0, 200)}`);
      }
    }
  }
  const html = renderSimulatorSheet(results);
  await writeFile(join(dir, "contact-sheet.html"), html);
  return results;
}

function renderSimulatorSheet(results) {
  const cells = results.map((r) => `
    <figure class="cell cell-${r.ok ? "ok" : "fail"}">
      <div class="thumb"><img src="${r.path.split("/").pop()}" alt="${r.label}"></div>
      <figcaption>
        <span class="label">${r.label}</span>
        <span class="meta">simulator ${r.udid.slice(0, 8)} · real WebKit + browser chrome</span>
      </figcaption>
    </figure>
  `).join("\n");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Visual matrix · iOS Simulator</title>
<style>
  body { margin: 0; padding: 24px; font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f4efe4; color: #2b2233; }
  h1 { font-family: ui-monospace, monospace; font-weight: 500; font-size: 18px; margin: 0 0 8px; }
  .sub { color: #6b6472; margin-bottom: 24px; font-family: ui-monospace, monospace; font-size: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px; }
  .cell { margin: 0; background: #fff; border: 1px solid #d0c8b8; }
  .cell-fail { border-color: #b23a3a; }
  .thumb { background: #ede6d5; } .thumb img { display: block; width: 100%; height: auto; }
  figcaption { padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; font-family: ui-monospace, monospace; font-size: 12px; }
  .label { color: #2b2233; } .meta { color: #6b6472; font-size: 11px; }
</style></head><body>
<h1>Visual matrix · iOS Simulator (real WebKit)</h1>
<p class="sub">Mobile Safari truth pass. Captures URL-reachable states with browser chrome present — the class of bug headless Chromium cannot see.</p>
<div class="grid">${cells}</div>
</body></html>`;
}

async function main() {
  await preflight();
  await mkdir(OUT_ROOT, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const viewport of VIEWPORTS) {
      console.log(`\n[matrix] viewport ${viewport.name}`);
      await runViewport(browser, viewport);
    }
  } finally {
    await browser.close();
  }
  console.log(`\n[matrix] simulator (real WebKit)`);
  try {
    await runSimulator();
  } catch (e) {
    console.log(`  [warn] simulator pass failed: ${String(e).slice(0, 200)}`);
  }
  console.log(`\n[matrix] done. Contact sheets:`);
  for (const v of VIEWPORTS) console.log(`  file://${process.cwd()}/${OUT_ROOT}/${v.name}/contact-sheet.html`);
  if (SIMULATOR_UDIDS.length > 0) console.log(`  file://${process.cwd()}/${OUT_ROOT}/simulator/contact-sheet.html`);
}

main().catch((e) => { console.error(e); process.exit(1); });
