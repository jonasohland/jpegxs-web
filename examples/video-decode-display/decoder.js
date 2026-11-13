// Decoder worker: decodes the JPEG XS frames as fast as possible with one
// decoder configuration. It does no rendering: the page asks for a frame on
// each animation frame ({ want: true }) and gets the next decoded one
// transferred ({ image }). Drawing to an OffscreenCanvas from this worker
// would throttle the decode loop to the display rate.
//
// The page starts one decoder worker per configuration and terminates it to
// switch, which also stops the codec's pthread workers.
import { JxsCodec } from "../../dist/codec.js";
import { runOnce, setStatus } from "./status.js";

// Yields to the event loop (to receive requests) without setTimeout's
// clamping of nested timers.
const channel = new MessageChannel();
function yieldTask() {
  return new Promise((ok) => {
    channel.port1.onmessage = ok;
    channel.port2.postMessage(null);
  });
}

let stopRequested = false;
let wanted = false;
let delivered = 0;
let last = null;

function deliver(image) {
  self.postMessage({ image }, [image.data.buffer]);
  wanted = false;
  delivered++;
}

self.addEventListener("message", ({ data }) => {
  if (data.stop) stopRequested = true;
  if (data.want) {
    wanted = true;
    // After the end of a non-looping run, hand out the final frame once.
    if (last) {
      deliver(last);
      last = null;
    }
  }
});

/**
 * Options:
 * - `data`, `offsets`: the transcode worker's result;
 * - `variant` ("threads" | "single"), `threads`: decoder configuration;
 * - `loop`: start over at the end of the clip;
 * - `warmupMs`, `durationMs`: if set, measure only after the warm-up and stop
 *   after the duration (benchmark mode).
 */
runOnce(async ({ data, offsets, variant, threads, loop, warmupMs = 0, durationMs = Infinity }) => {
  const codec = await JxsCodec.create({ variant, threads });
  const label = codec.variant === "single" ? "single-threaded build" : `threaded build, threads: ${threads}`;

  const bytes = new Uint8Array(data);
  const n = offsets.length - 1;
  const frame = (i) => bytes.subarray(offsets[i], offsets[i + 1]);

  // Totals (after the warm-up) and a 500 ms window for the live status.
  const total = {};
  const win = {};
  const reset = (s, now) => Object.assign(s, { start: now, decoded: 0, decodeTime: 0, delivered });
  const summary = (s, now) => {
    const seconds = (now - s.start) / 1000;
    return {
      fps: s.decoded / seconds,
      msPerFrame: s.decodeTime / s.decoded,
      renderFps: (delivered - s.delivered) / seconds,
      frames: s.decoded,
      seconds,
    };
  };

  const begin = performance.now();
  let warm = warmupMs === 0;
  reset(total, begin);
  reset(win, begin);

  let image = null;
  for (let i = 0; !stopRequested; ) {
    const t0 = performance.now();
    image = codec.decode(frame(i));
    const t1 = performance.now();
    for (const s of [total, win]) {
      s.decodeTime += t1 - t0;
      s.decoded++;
    }
    if (wanted) {
      deliver(image);
      image = null;
    }

    if (!warm && t1 - begin >= warmupMs) {
      warm = true;
      reset(total, t1);
    }
    if (t1 - win.start >= 500) {
      const s = summary(win, t1);
      setStatus("decode", `${s.fps.toFixed(0)} fps, ${s.msPerFrame.toFixed(2)} ms/frame (${label}), frame ${i + 1} / ${n}`);
      setStatus("render", `${s.renderFps.toFixed(0)} fps`);
      reset(win, t1);
    }
    if (warm && t1 - total.start >= durationMs) break;

    if (++i === n) {
      if (!loop) break;
      i = 0;
    }
    await yieldTask();
  }
  last = image;

  const result = { label, ...summary(total, performance.now()) };
  setStatus(
    "decode",
    `${result.frames} frames in ${result.seconds.toFixed(2)} s: ${result.fps.toFixed(0)} fps, ` +
      `${result.msPerFrame.toFixed(2)} ms/frame (${label})`,
  );
  codec.dispose();
  return result;
});
