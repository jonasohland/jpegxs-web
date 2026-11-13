// Runs test/browser/index.html in headless Chrome and checks its results
// against the node build of the same codec (which test/codec.test.ts ties to
// the native reference apps). The page is loaded twice: cross-origin isolated
// (threaded build) and without isolation (single-threaded build).
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

const CASES = [
  [1920, 1080, "yuv420", 8, 3],
  [1280, 720, "yuv422", 10, 2.5],
];

const sha = (b) => createHash("sha256").update(b).digest("hex");
const codec = await JxsCodec.create({ threads: 4 });
const expected = CASES.map(([w, h, format, depth, bpp]) => {
  const cs = codec.encode({ width: w, height: h, bitDepth: depth, format, data: makeImage(w, h, format, depth) }, { bpp });
  return {
    cs,
    codestream: sha(cs),
    decoded: sha(codec.decode(cs).data),
    half: sha(codec.decode(cs, { proxy: "half" }).data),
    probe: [w, h, format, depth, cs.length],
    planeTypes: Array(3).fill(depth > 8 ? "Uint16Array" : "Uint8Array"),
  };
});
codec.dispose();

const chrome = process.env.CHROME ?? "google-chrome-stable";

async function runPage(query) {
  let resolveResult;
  const result = new Promise((ok) => (resolveResult = ok));
  const server = await serve(0, (req, res) => {
    const m = /^\/codestream\/(\d+)$/.exec(req.url ?? "");
    if (req.method === "GET" && m) {
      res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(expected[Number(m[1])].cs);
      return true;
    }
    if (req.method !== "POST" || req.url !== "/result") return false;
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      res.writeHead(204).end();
      resolveResult(JSON.parse(body));
    });
    return true;
  });
  const url = `http://127.0.0.1:${server.address().port}/test/browser/${query}`;
  const profile = mkdtempSync(join(tmpdir(), "jxs-chrome-"));
  const browser = spawn(chrome, ["--headless=new", "--no-first-run", `--user-data-dir=${profile}`, url], {
    stdio: "ignore",
  });
  const timeout = setTimeout(() => resolveResult({ ok: false, error: "timeout" }), 60_000);
  try {
    return await result;
  } finally {
    clearTimeout(timeout);
    browser.kill();
    server.close();
    setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
  }
}

function checkDecode(actual, exp, what) {
  assert.deepEqual(actual.probe, exp.probe, `${what}: probe`);
  assert.equal(actual.decoded, exp.decoded, `${what}: decode differs from node`);
  assert.equal(actual.half[2], exp.half, `${what}: half-res decode differs from node`);
  assert.deepEqual(actual.planeTypes, exp.planeTypes, `${what}: plane types`);
}

for (const isolated of [true, false]) {
  const r = await runPage(isolated ? "" : "?no-isolation");
  console.log(JSON.stringify(r, null, 2));
  assert.ok(r.ok, r.error);
  assert.equal(r.crossOriginIsolated, isolated);
  assert.equal(r.variant, isolated ? "threads" : "single");
  assert.equal(r.singleVariant, "single");
  assert.deepEqual(r.error.slice(0, 1), ["JxsError"]);
  if (!isolated) assert.match(r.encodeError, /threaded variant/);
  r.cases.forEach((c, i) => {
    const exp = expected[i];
    const what = `${c.size[0]}x${c.size[1]} ${isolated ? "isolated" : "not isolated"}`;
    assert.equal(c.codestream, exp.codestream, `${what}: codestream differs from node`);
    if (isolated) checkDecode(c, exp, `${what} threads`);
    checkDecode(c.single, exp, `${what} single`);
  });
}
console.log("browser test passed");
process.exit(0);
