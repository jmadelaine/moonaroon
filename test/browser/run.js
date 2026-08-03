// Runs the browser cases in real Chromium and exits non-zero if any fail.
//
// Real Chromium rather than jsdom, and not negotiable: parseColor paints into a
// <canvas>, buildOverlay walks live CSSOM rule objects, and the constructs this
// transform exists to handle — replaceSync, native nesting, @layer, oklch() —
// are exactly the ones a shim gets wrong. A test that passes against a fake
// CSSOM says nothing.
//
// Each case gets its own Chrome process and its own ephemeral profile. Results
// come back by POST rather than --dump-dom, which serializes at load and so
// misses anything behind a timer or a fetch.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const os = require("node:os");

const ROOT = path.join(__dirname, "..", "..");
const CASES = path.join(__dirname, "cases");
const PER_CASE_TIMEOUT = 20000;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(
    "No Chrome found. Set CHROME_PATH to a Chrome or Chromium binary.",
  );
}

// content.js with its chrome.storage wiring removed. There is no extension
// runtime on a plain page to supply the stored state, so the cases call
// applyDark()/removeDark() themselves. Served rather than written to disk, so
// the tests always run against the working tree with no build step.
function themeSource() {
  const src = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
  const cut = src.indexOf("// Initial state");
  if (cut === -1)
    throw new Error("content.js has no '// Initial state' marker to cut at");
  return src.slice(0, cut);
}

function startServer(onResults) {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/results") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(204).end();
        try {
          onResults(JSON.parse(body));
        } catch (e) {
          onResults({ page: "?", results: [{ name: "bad payload", pass: false, detail: String(e) }] });
        }
      });
      return;
    }
    if (req.url === "/theme.js") {
      res.writeHead(200, { "Content-Type": TYPES[".js"] }).end(themeSource());
      return;
    }
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res
      .writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" })
      .end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function runCase(chrome, port, name) {
  return new Promise((resolve) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "moonaroon-test-"));
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Kill only the process we spawned. Never pkill Chrome — that would take
      // out the developer's own browser session.
      try {
        child.kill("SIGKILL");
      } catch (e) {}
      fs.rmSync(profile, { recursive: true, force: true });
      resolve(payload);
    };

    pending.set(`/test/browser/cases/${name}`, finish);

    const child = spawn(
      chrome,
      [
        "--headless",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        `--user-data-dir=${profile}`,
        `http://127.0.0.1:${port}/test/browser/cases/${name}`,
      ],
      { stdio: "ignore" },
    );

    const timer = setTimeout(
      () =>
        finish({
          page: name,
          results: [
            { name: "reported results", pass: false, detail: `no POST within ${PER_CASE_TIMEOUT}ms` },
          ],
        }),
      PER_CASE_TIMEOUT,
    );
  });
}

const pending = new Map();

async function main() {
  const chrome = findChrome();
  const server = await startServer((payload) => {
    const done = pending.get(payload.page);
    if (done) {
      pending.delete(payload.page);
      done(payload);
    }
  });
  const port = server.address().port;

  const cases = fs.readdirSync(CASES).filter((f) => f.endsWith(".html")).sort();
  let failed = 0,
    total = 0;

  for (const name of cases) {
    const payload = await runCase(chrome, port, name);
    const fails = payload.results.filter((r) => !r.pass);
    total += payload.results.length;
    failed += fails.length;
    const mark = fails.length ? "FAIL" : "ok  ";
    console.log(`${mark} ${name}  (${payload.results.length - fails.length}/${payload.results.length})`);
    for (const r of payload.results)
      if (!r.pass) console.log(`       x ${r.name}\n         ${r.detail}`);
  }

  server.close();
  console.log(`\n${total - failed}/${total} assertions passed across ${cases.length} pages`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
