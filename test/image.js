// Deterministic synthetic test images, shared by the node and browser tests.

const CHROMA = {
  yuv420: (w, h) => [w >> 1, h >> 1],
  yuv422: (w, h) => [w >> 1, h],
  yuv444: (w, h) => [w, h],
};

/**
 * Gradients, a checkerboard and some noise; 3 planes, tightly packed, 16-bit
 * little endian samples for depth > 8.
 * @param {number} w
 * @param {number} h
 * @param {"yuv420" | "yuv422" | "yuv444"} format
 * @param {number} depth
 * @param {number} [seed]
 * @returns {Uint8Array}
 */
export function makeImage(w, h, format, depth, seed = 1) {
  const [cw, ch] = CHROMA[format](w, h);
  const max = (1 << depth) - 1;
  const sizes = [
    [w, h],
    [cw, ch],
    [cw, ch],
  ];
  const total = sizes.reduce((a, [pw, ph]) => a + pw * ph, 0);
  const samples = depth > 8 ? new Uint16Array(total) : new Uint8Array(total);
  let state = seed;
  const rnd = () => ((state = (state * 1103515245 + 12345) >>> 0) >>> 16) / 65536;
  let i = 0;
  for (const [pw, ph] of sizes) {
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        let v = ((x * 7 + y * 3 + seed * 11) % 256) / 255;
        if (((x >> 5) + (y >> 5)) & 1) v = 1 - v;
        v = v * max + (rnd() - 0.5) * (max / 8);
        samples[i++] = Math.min(max, Math.max(0, Math.round(v)));
      }
    }
  }
  return new Uint8Array(samples.buffer);
}
