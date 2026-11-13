#!/usr/bin/env node
// Encode/decode throughput benchmark for a built jpegxs-web dist directory.
//
//   node scripts/bench.mjs [dist-dir] [--threads 1,4] [--frames 30] [--json]
//
// For every case and thread count it reports the median and minimum time per
// frame (after warm-up) and a SHA-256 of the codestream and decoded output, so
// that two builds can be compared both for speed and for bit-exactness.
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { makeImage } from "../test/image.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    threads: { type: "string", default: "1,4" },
    frames: { type: "string", default: "30" },
    warmup: { type: "string", default: "3" },
    cases: { type: "string" },
    json: { type: "boolean", default: false },
  },
});

const dist = resolve(positionals[0] ?? "dist");
const { JxsCodec } = await import(pathToFileURL(`${dist}/codec.js`).href);

const CASES = [
  { name: "1080p-420-8", width: 1920, height: 1080, format: "yuv420", depth: 8, options: { bpp: 3 } },
  { name: "1080p-422-10", width: 1920, height: 1080, format: "yuv422", depth: 10, options: { bpp: 4 } },
  { name: "720p-444-12", width: 1280, height: 720, format: "yuv444", depth: 12, options: { bpp: 6, codingSigns: 2, verticalPrediction: 1 } },
  { name: "2160p-422-10", width: 3840, height: 2160, format: "yuv422", depth: 10, options: { bpp: 3 } },
];
const selected = values.cases ? CASES.filter((c) => values.cases.split(",").includes(c.name)) : CASES;
const frames = Number(values.frames);
const warmup = Number(values.warmup);

const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

function time(fn) {
  const ms = [];
  let out;
  for (let i = 0; i < warmup + frames; i++) {
    const t = performance.now();
    out = fn();
    if (i >= warmup) ms.push(performance.now() - t);
  }
  return { out, median: median(ms), min: Math.min(...ms) };
}

const results = [];
for (const threads of values.threads.split(",").map(Number)) {
  const codec = await JxsCodec.create({ threads });
  for (const c of selected) {
    const data = makeImage(c.width, c.height, c.format, c.depth);
    const image = { width: c.width, height: c.height, bitDepth: c.depth, format: c.format, data };
    const enc = time(() => codec.encode(image, c.options));
    const dec = time(() => codec.decode(enc.out));
    const r = {
      case: c.name,
      threads,
      encMs: enc.median,
      encMinMs: enc.min,
      decMs: dec.median,
      decMinMs: dec.min,
      encSha: sha(enc.out),
      decSha: sha(dec.out.data),
    };
    results.push(r);
    if (!values.json) {
      console.log(
        `${c.name.padEnd(14)} t=${threads}  enc ${r.encMs.toFixed(1).padStart(6)} ms (min ${r.encMinMs.toFixed(1)})` +
          `  dec ${r.decMs.toFixed(1).padStart(6)} ms (min ${r.decMinMs.toFixed(1)})  ${r.encSha} ${r.decSha}`,
      );
    }
  }
  codec.dispose();
}
if (values.json) console.log(JSON.stringify(results, null, 2));
process.exit(0);
