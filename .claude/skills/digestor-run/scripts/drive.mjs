// Drive the running Digestor web app with Playwright and save screenshots + console errors.
// Playwright lives outside the repo (~/.cache/digestor-run) so it never touches the lockfile.
//
//   node drive.mjs --out <dir> [--base http://localhost:3000] [--password <pw>]
//                  [--visit <path>]... [--upload <file>] [--keys <path>=<k1,k2,...>] [--mobile]
//
// --visit   screenshot a page, e.g. /  /s/<id>  /s/<id>/export
// --upload  upload a file from the home page, follow the redirect to /s/<id>, screenshot it
// --keys    open a page, press keys in order (Playwright key names: a, n, r, e, ArrowDown, Escape),
//           screenshot after each key: e.g. /s/<id>=a,ArrowDown,n,ArrowDown,r
// --mobile  also capture each screenshot at 390 px wide
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(path.join(homedir(), ".cache/digestor-run/package.json"));
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const all = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
const one = (flag, dflt) => all(flag)[0] ?? dflt;

const base = one("--base", "http://localhost:3000");
const out = path.resolve(one("--out", "./digestor-run-shots"));
const password = one("--password", process.env.APP_PASSWORD ?? "");
const mobile = args.includes("--mobile");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await context.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(`[console] ${page.url()} ${m.text()}`));
page.on("pageerror", (e) => errors.push(`[pageerror] ${page.url()} ${e.message}`));
page.on("response", (r) => r.status() >= 500 && errors.push(`[http ${r.status()}] ${r.url()}`));

let n = 0;
const slug = (s) => s.replace(/^\/+/, "").replace(/[^a-z0-9]+/gi, "-").slice(0, 60) || "home";
async function shot(label) {
  const file = path.join(out, `${String(++n).padStart(2, "0")}-${slug(label)}.png`);
  await page.screenshot({ path: file, fullPage: true });
  if (mobile) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: file.replace(/\.png$/, "-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 860 });
  }
  console.log(`shot ${file}`);
}
// Pages stream behind a Suspense fallback (app bar only) and the Processing screen holds an SSE connection open,
// so "networkidle" is wrong both ways: wait for the real <main> content instead.
async function settle() {
  await page.locator("main").first().waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(600);
}
async function go(p) {
  await page.goto(base + p, { waitUntil: "load" });
  if (new URL(page.url()).pathname === "/login") {
    if (!password) throw new Error("Redirected to /login: pass --password or set APP_PASSWORD");
    await page.getByLabel("Password").fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((u) => u.pathname !== "/login");
    await page.goto(base + p, { waitUntil: "load" });
  }
  await settle();
}

try {
  for (const p of all("--visit")) {
    await go(p);
    await shot(p);
  }
  const upload = one("--upload");
  if (upload) {
    await go("/");
    await page.locator('input[type="file"]').setInputFiles(path.resolve(upload));
    await page.getByRole("button", { name: /Digest this video/ }).click();
    await page.waitForURL(/\/s\/[0-9a-f-]{36}/, { timeout: 120_000 });
    await settle();
    console.log(`session ${page.url()}`);
    await shot("after-upload");
  }
  for (const spec of all("--keys")) {
    const [p, keys] = spec.split("=");
    await go(p);
    await shot(`${p}-before-keys`);
    for (const k of keys.split(",")) {
      await page.keyboard.press(k);
      await page.waitForTimeout(400);
      await shot(`${p}-key-${k}`);
    }
  }
} finally {
  writeFileSync(path.join(out, "errors.txt"), errors.join("\n") + (errors.length ? "\n" : ""));
  console.log(errors.length ? `${errors.length} error(s) — see ${out}/errors.txt` : "no console/page/5xx errors");
  await browser.close();
}
