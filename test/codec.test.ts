// Tests for the synchronous JxsCodec under node, run against the built dist/.
// Encoder and decoder output is compared byte-for-byte with the native
// reference apps (SvtJpegxsEncApp / SvtJpegxsDecApp) when they are on PATH
// (they are in the dev shell). Set JXS_REQUIRE_NATIVE=1 to make their absence
// an error.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JxsCodec } from "../dist/codec.js";
import { JxsError, type ColourFormat, type EncodeOptions } from "../dist/index.js";
import { makeImage } from "./image.js";

function hasNative(): boolean {
  try {
    execFileSync("SvtJpegxsDecApp", ["--help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const native = hasNative();
// The Nix check sets this so a missing reference app fails instead of skipping.
if (process.env.JXS_REQUIRE_NATIVE === "1" && !native) {
  throw new Error("JXS_REQUIRE_NATIVE=1 but SvtJpegxsDecApp is not on PATH");
}

interface Case {
  name: string;
  width: number;
  height: number;
  format: ColourFormat;
  depth: number;
  options: EncodeOptions;
  nativeArgs: string[];
}

// Same configurations as spike/compare.sh.
const CASES: Case[] = [
  { name: "a", width: 1920, height: 1080, format: "yuv420", depth: 8, options: { bpp: 3 }, nativeArgs: ["--bpp", "3"] },
  { name: "b", width: 1280, height: 720, format: "yuv422", depth: 10, options: { bpp: 4 }, nativeArgs: ["--bpp", "4"] },
  {
    name: "c",
    width: 640,
    height: 480,
    format: "yuv444",
    depth: 12,
    options: { bpp: 6, codingSigns: 2, verticalPrediction: 1 },
    nativeArgs: ["--bpp", "6", "--coding-signs", "2", "--coding-vpred", "1"],
  },
  {
    name: "d",
    width: 1000,
    height: 600,
    format: "yuv422",
    depth: 10,
    options: { bpp: 2.5, rateControl: 3, decompV: 1, decompH: 3 },
    nativeArgs: ["--bpp", "2.5", "--rc", "3", "--decomp_v", "1", "--decomp_h", "3"],
  },
];

let codec: JxsCodec;
let work: string;

before(async () => {
  codec = await JxsCodec.create({ threads: 4 });
  work = mkdtempSync(join(tmpdir(), "jxs-test-"));
});

after(() => {
  codec.dispose();
  rmSync(work, { recursive: true, force: true });
});

function nativeEncode(c: Case, yuv: Uint8Array): Uint8Array {
  const input = join(work, `${c.name}.yuv`);
  const output = join(work, `${c.name}.native.jxs`);
  writeFileSync(input, yuv);
  execFileSync("SvtJpegxsEncApp", [
    "-i", input, "-b", output,
    "-w", String(c.width), "-h", String(c.height),
    "--colour-format", c.format, "--input-depth", String(c.depth),
    "-n", "1", "--no-progress", "1", "-v", "0",
    ...c.nativeArgs,
  ], { stdio: "ignore" });
  return readFileSync(output);
}

function nativeDecode(name: string, codestream: Uint8Array, proxy = 0): Uint8Array {
  const input = join(work, `${name}.in.jxs`);
  const output = join(work, `${name}.native.dec.yuv`);
  writeFileSync(input, codestream);
  execFileSync("SvtJpegxsDecApp", ["-i", input, "-o", output, "-v", "0", "--proxy-mode", String(proxy)], {
    stdio: "ignore",
  });
  return readFileSync(output);
}

function sameBytes(actual: Uint8Array, expected: Uint8Array, what: string): void {
  assert.equal(actual.length, expected.length, `${what}: length`);
  assert.ok(Buffer.compare(Buffer.from(actual), Buffer.from(expected)) === 0, `${what}: contents differ`);
}

describe("encode + decode", () => {
  for (const c of CASES) {
    test(`case ${c.name}: ${c.width}x${c.height} ${c.format} ${c.depth}-bit`, () => {
      const image = { width: c.width, height: c.height, bitDepth: c.depth, format: c.format };
      const yuv = makeImage(c.width, c.height, c.format, c.depth);

      const cfg = codec.encoderConfig(image, c.options);
      assert.equal(cfg.components.reduce((a, x) => a + x.byteSize, 0), yuv.length);

      const codestream = codec.encode({ ...image, data: yuv }, c.options);
      assert.ok(codestream.length > 0 && codestream.length <= cfg.frameSize);

      const info = codec.probe(codestream);
      assert.equal(info.width, c.width);
      assert.equal(info.height, c.height);
      assert.equal(info.bitDepth, c.depth);
      assert.equal(info.format, c.format);
      assert.equal(info.frameSize, codestream.length);

      const decoded = codec.decode(codestream);
      assert.equal(decoded.data.length, yuv.length);
      assert.equal(decoded.planes.length, 3);
      assert.ok(decoded.planes[0] instanceof (c.depth > 8 ? Uint16Array : Uint8Array));
      assert.equal(decoded.planes[0]!.byteLength, decoded.components[0]!.byteSize);

      if (native) {
        sameBytes(codestream, nativeEncode(c, yuv), "codestream vs native encoder");
        sameBytes(decoded.data, nativeDecode(c.name, codestream), "decoded vs native decoder");
      }
    });
  }
});

describe("decode", () => {
  const image = { width: 640, height: 360, bitDepth: 10, format: "yuv422" as const };

  test("proxy modes", () => {
    const codestream = codec.encode({ ...image, data: makeImage(640, 360, "yuv422", 10) }, { bpp: 4 });
    for (const [proxy, mode, w, h] of [
      [1, "half", 320, 180],
      [2, "quarter", 160, 90],
    ] as const) {
      const decoded = codec.decode(codestream, { proxy: mode });
      assert.equal(decoded.width, w);
      assert.equal(decoded.height, h);
      if (native) sameBytes(decoded.data, nativeDecode(`proxy${proxy}`, codestream, proxy), `${mode} vs native`);
    }
    // Back to full resolution with the cached decoder replaced again.
    assert.equal(codec.decode(codestream).width, 640);
  });

  test("decoder is reused across frames and reopened on shape changes", () => {
    const frames = [1, 2, 3].map((seed) =>
      codec.encode({ ...image, data: makeImage(640, 360, "yuv422", 10, seed) }, { bpp: 3 }),
    );
    const other = codec.encode(
      { width: 320, height: 240, bitDepth: 8, format: "yuv420", data: makeImage(320, 240, "yuv420", 8) },
      { bpp: 2 },
    );
    const differentCoding = codec.encode(
      { ...image, data: makeImage(640, 360, "yuv422", 10, 1) },
      { bpp: 3, decompV: 1, decompH: 4 },
    );
    const sequence = [frames[0]!, frames[1]!, other, frames[2]!, differentCoding, frames[0]!];
    const results = sequence.map((cs) => codec.decode(cs));
    assert.deepEqual(
      results.map((r) => [r.width, r.height]),
      [[640, 360], [640, 360], [320, 240], [640, 360], [640, 360], [640, 360]],
    );
    sameBytes(results[5]!.data, results[0]!.data, "same frame decodes identically");
    if (native) {
      sequence.forEach((cs, i) => sameBytes(results[i]!.data, nativeDecode(`seq${i}`, cs), `frame ${i} vs native`));
    }
  });

  test("invalid input throws JxsError", () => {
    assert.throws(() => codec.decode(new Uint8Array(1000)), (e) => e instanceof JxsError && e.code !== 0);
    assert.throws(() => codec.probe(new Uint8Array(4)), JxsError);
    // The codec stays usable afterwards.
    const cs = codec.encode({ ...image, data: makeImage(640, 360, "yuv422", 10) }, { bpp: 3 });
    assert.equal(codec.decode(cs).width, 640);
  });

  test("truncated codestream", () => {
    const cs = codec.encode({ ...image, data: makeImage(640, 360, "yuv422", 10) }, { bpp: 3 });
    assert.throws(() => codec.decode(cs.subarray(0, cs.length >> 1)), JxsError);
  });
});

describe("encode", () => {
  const image = { width: 320, height: 240, bitDepth: 8, format: "yuv420" as const };

  test("planes and contiguous data give the same codestream", () => {
    const data = makeImage(320, 240, "yuv420", 8);
    const planes = [data.subarray(0, 76800), data.subarray(76800, 96000), data.subarray(96000)];
    sameBytes(codec.encode({ ...image, planes }, { bpp: 2 }), codec.encode({ ...image, data }, { bpp: 2 }), "codestream");
  });

  test("16-bit planes are accepted as Uint16Array", () => {
    const data = makeImage(320, 240, "yuv444", 10);
    const u16 = new Uint16Array(data.buffer);
    const n = 320 * 240;
    const planes = [u16.subarray(0, n), u16.subarray(n, 2 * n), u16.subarray(2 * n)];
    const img = { width: 320, height: 240, bitDepth: 10, format: "yuv444" as const };
    sameBytes(codec.encode({ ...img, planes }, { bpp: 4 }), codec.encode({ ...img, data }, { bpp: 4 }), "codestream");
  });

  test("wrong input sizes are rejected", () => {
    assert.throws(() => codec.encode({ ...image, data: new Uint8Array(10) }, { bpp: 2 }), RangeError);
    assert.throws(() => codec.encode({ ...image, planes: [new Uint8Array(76800)] }, { bpp: 2 }), RangeError);
  });

  test("invalid parameters throw JxsError", () => {
    assert.throws(
      () => codec.encode({ ...image, data: makeImage(320, 240, "yuv420", 8) }, { bpp: 2, decompH: 9 }),
      JxsError,
    );
  });

  test("bpp tuple equals decimal", () => {
    const data = makeImage(320, 240, "yuv420", 8);
    sameBytes(
      codec.encode({ ...image, data }, { bpp: [25, 10] }),
      codec.encode({ ...image, data }, { bpp: 2.5 }),
      "codestream",
    );
  });
});
