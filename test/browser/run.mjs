// Runs test/browser/index.html in headless Chrome and checks its results
// against the node build of the same codec (which test/codec.test.ts ties to
// the native reference apps).
// Usage: node test/browser/run.mjs   (CHROME=/path/to/chrome to override)
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

import { serve } from "../../scripts/serve.mjs";
import { JxsCodec } from "../../dist/codec.js";
import { makeImage } from "../image.js";

const chrome = process.env.CHROME ?? "google-chrome-stable";
let resolveResult;
const result = new Promise((ok) => (resolveResult = ok));
const server = await serve(0, (req, res) => {
  if (req.method !== "POST" || req.url !== "/result") return false;
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    res.writeHead(204).end();
    resolveResult(JSON.parse(body));
  });
  return true;
});
const url = `http://127.0.0.1:${server.address().port}/test/browser/`;
const profile = mkdtempSync(join(tmpdir(), "jxs-chrome-"));
const browser = spawn(chrome, ["--headless=new", "--no-first-run", `--user-data-dir=${profile}`, url], {
  stdio: "ignore",
});

const timeout = setTimeout(() => resolveResult({ ok: false, error: "timeout" }), 60_000);
let r;
try {
  r = await result;
} finally {
  clearTimeout(timeout);
  browser.kill();
  server.close();
}
setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);

console.log(JSON.stringify(r, null, 2));
assert.ok(r.ok, r.error);
assert.equal(r.crossOriginIsolated, true);
assert.deepEqual(r.error.slice(0, 1), ["JxsError"]);

const sha = (b) => createHash("sha256").update(b).digest("hex");
const codec = await JxsCodec.create({ threads: 4 });
for (const c of r.cases) {
  const [w, h, format, depth, bpp] = c.size;
  const cs = codec.encode({ width: w, height: h, bitDepth: depth, format, data: makeImage(w, h, format, depth) }, { bpp });
  assert.equal(c.codestream, sha(cs), `${w}x${h}: browser codestream differs from node`);
  assert.equal(c.decoded, sha(codec.decode(cs).data), `${w}x${h}: browser decode differs from node`);
  assert.equal(c.half[2], sha(codec.decode(cs, { proxy: "half" }).data), `${w}x${h}: half-res decode differs`);
  assert.deepEqual(c.probe, [w, h, format, depth, cs.length]);
  assert.deepEqual(c.planeTypes, Array(3).fill(depth > 8 ? "Uint16Array" : "Uint8Array"));
}
codec.dispose();
console.log("browser test passed");
process.exit(0);
