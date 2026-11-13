// Packages examples/video-decode-display as one self-contained directory that
// any static web server can serve: the demo files, the parts of dist/ it
// loads (lib/), data/bbb.mp4 and an nginx config snippet. Run `npm run build`
// first (or use `npm run build:demo`, which does both).
// Usage: node scripts/build-demo.mjs [out-dir]   (default build/demo)
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SRC = join(ROOT, "examples/video-decode-display");
const DIST = join(ROOT, "dist");
const VIDEO = join(ROOT, "data/bbb.mp4");
const OUT = resolve(process.argv[2] ?? join(ROOT, "build/demo"));

// What the demo loads from dist/: the synchronous codec, its imports and
// both wasm builds (jxs.mjs also starts its pthread workers from jxs.mjs).
const LIB = ["codec.js", "abi.js", "types.js", "jxs.mjs", "jxs.wasm", "jxs-st.mjs", "jxs-st.wasm"];
const MAPS = ["codec.js.map", "abi.js.map", "types.js.map"];
const DEMO = ["index.html", "transcode.js", "decoder.js", "status.js", "demuxer_mp4.js", "renderer_2d.js", "renderer_webgl.js"];

// Repo-relative paths in the demo sources and their packaged equivalents.
// Each must occur exactly once per listed file.
const REWRITES = {
  "transcode.js": [['"../../dist/codec.js"', '"./lib/codec.js"']],
  "decoder.js": [['"../../dist/codec.js"', '"./lib/codec.js"']],
  "index.html": [['"../../data/bbb.mp4"', '"./bbb.mp4"']],
};

function fail(message) {
  console.error(`build-demo: ${message}`);
  process.exit(1);
}

for (const f of LIB) {
  if (!existsSync(join(DIST, f))) fail(`dist/${f} is missing, run \`npm run build\` first`);
}
if (!existsSync(VIDEO)) fail("data/bbb.mp4 is missing");
if (OUT === ROOT || ROOT.startsWith(OUT + "/")) fail(`refusing to replace ${OUT}`);
// The output directory is deleted first: only accept an empty one or an
// earlier demo build.
if (existsSync(OUT) && readdirSync(OUT).length > 0 && !existsSync(join(OUT, "lib/codec.js"))) {
  fail(`${OUT} exists and does not look like a demo build, not replacing it`);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "lib"), { recursive: true });

for (const f of DEMO) {
  let text = readFileSync(join(SRC, f), "utf8");
  for (const [from, to] of REWRITES[f] ?? []) {
    const n = text.split(from).length - 1;
    if (n !== 1) fail(`expected ${from} once in ${f}, found it ${n} times`);
    text = text.replace(from, to);
  }
  if (text.includes("../../")) fail(`${f} still refers outside the demo directory`);
  writeFileSync(join(OUT, f), text);
}
for (const f of LIB) copyFileSync(join(DIST, f), join(OUT, "lib", f));
for (const f of MAPS) if (existsSync(join(DIST, f))) copyFileSync(join(DIST, f), join(OUT, "lib", f));
copyFileSync(VIDEO, join(OUT, "bbb.mp4"));

writeFileSync(
  join(OUT, "nginx.conf"),
  `# JPEG XS demo: example nginx location for this directory.
#
# Requirements:
# - Cross-origin isolation (COOP + COEP headers) on every response: the
#   threaded wasm build needs SharedArrayBuffer, and encoding (the transcode
#   step) only exists in that build.
# - A secure context: HTTPS, or http://localhost. Over plain HTTP on another
#   host the page is not isolated, whatever the headers say.
# - JavaScript MIME type for .mjs (module scripts are rejected otherwise;
#   older nginx mime.types lack it) and application/wasm for .wasm (needed
#   for streaming compilation).
#
# Note: add_header in a location replaces all add_header directives
# inherited from the server block.

location /jpegxs-demo/ {
    alias /srv/jpegxs-demo/;   # this directory

    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;

    # Replaces the global MIME map inside this location.
    types {
        text/html        html;
        text/javascript  js mjs;
        application/json map;
        application/wasm wasm;
        video/mp4        mp4;
    }

    # Optional: the wasm files compress to about 40%.
    gzip on;
    gzip_types text/javascript application/wasm application/json;
}
`,
);

let total = 0;
const list = [...DEMO, ...LIB.map((f) => `lib/${f}`), "bbb.mp4", "nginx.conf"];
for (const f of list) total += statSync(join(OUT, f)).size;
console.log(`build-demo: wrote ${list.length} files (${(total / 1024 ** 2).toFixed(1)} MiB) to ${OUT}`);
