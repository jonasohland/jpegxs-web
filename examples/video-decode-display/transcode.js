// Transcode worker: fetches an MP4 and transcodes its first frames to JPEG XS
// (WebCodecs H.264 decode → JxsCodec.encode with the threaded build). The
// codestreams are returned packed into one SharedArrayBuffer, so any number of
// decoder workers can read them without copies.
import { JxsCodec } from "../../dist/codec.js";
import { demuxMp4 } from "./demuxer_mp4.js";
import { runOnce, setStatus } from "./status.js";

const MiB = 1024 ** 2;
const mib = (bytes) => `${(bytes / MiB).toFixed(1)} MiB`;

runOnce(async ({ dataUri, frameLimit, bpp, threads }) => {
  if (!self.crossOriginIsolated) {
    throw new Error("the page is not cross-origin isolated; encoding needs the threaded build (serve with scripts/serve.mjs)");
  }

  const { config, samples } = await demuxMp4(dataUri, (received, total) =>
    setStatus("fetch", total ? `${mib(received)} / ${mib(total)}` : mib(received)),
  );
  setStatus("fetch", "Done");
  setStatus("demux", `${config.codec} @ ${config.codedWidth}x${config.codedHeight}, ${samples.length} samples`);

  const codec = await JxsCodec.create({ variant: "threads", threads });
  const { codestreams, colorSpace } = await transcode(codec, config, samples, frameLimit, bpp);
  codec.dispose();

  // Pack: one SharedArrayBuffer plus n + 1 offsets.
  const offsets = new Uint32Array(codestreams.length + 1);
  codestreams.forEach((cs, i) => (offsets[i + 1] = offsets[i] + cs.length));
  const packed = new Uint8Array(new SharedArrayBuffer(offsets[codestreams.length]));
  codestreams.forEach((cs, i) => packed.set(cs, offsets[i]));
  return { data: packed.buffer, offsets, colorSpace };
});

// RGB formats a VideoDecoder may output (Firefox outputs BGRX), with the
// byte offsets of R, G and B within a pixel.
const RGB_FORMATS = { RGBA: [0, 1, 2], RGBX: [0, 1, 2], BGRA: [2, 1, 0], BGRX: [2, 1, 0] };

// What frames converted from RGB are encoded as: BT.709, limited range.
const BT709 = { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false };

/**
 * Copies the visible area of a VideoFrame into `out` as tightly packed I420
 * and returns the colour space of the result (VideoColorSpaceInit).
 */
class FrameConverter {
  #scratch = new Uint8Array(0);

  #scratchOf(size) {
    if (this.#scratch.length < size) this.#scratch = new Uint8Array(size);
    return this.#scratch;
  }

  async convert(frame, out) {
    const { width, height } = frame.visibleRect;
    const cw = (width + 1) >> 1;
    const ch = (height + 1) >> 1;
    const ySize = width * height;
    if (frame.format === "I420") {
      await frame.copyTo(out, {
        layout: [
          { offset: 0, stride: width },
          { offset: ySize, stride: cw },
          { offset: ySize + cw * ch, stride: cw },
        ],
      });
      return frame.colorSpace.toJSON();
    }
    if (frame.format === "NV12") {
      const nv12 = this.#scratchOf(ySize + 2 * cw * ch);
      await frame.copyTo(nv12, { layout: [{ offset: 0, stride: width }, { offset: ySize, stride: 2 * cw }] });
      out.set(nv12.subarray(0, ySize));
      const uv = nv12.subarray(ySize);
      const u = out.subarray(ySize, ySize + cw * ch);
      const v = out.subarray(ySize + cw * ch);
      for (let i = 0; i < cw * ch; i++) {
        u[i] = uv[2 * i];
        v[i] = uv[2 * i + 1];
      }
      return frame.colorSpace.toJSON();
    }
    const channels = RGB_FORMATS[frame.format];
    if (!channels) throw new Error(`unsupported VideoFrame format ${frame.format}`);
    const rgb = this.#scratchOf(4 * ySize);
    await frame.copyTo(rgb, { layout: [{ offset: 0, stride: 4 * width }] });
    rgbToI420(rgb, channels, width, height, out);
    return BT709;
  }
}

/** BT.709 limited-range RGB → I420, chroma from the average of 2×2 pixels. */
function rgbToI420(rgb, [r, g, b], width, height, out) {
  const kr = 0.2126;
  const kb = 0.0722;
  const kg = 1 - kr - kb;
  const ys = 219 / 255;
  const cs = 224 / 255;
  // Y = 16 + ys·(kr·R + kg·G + kb·B); Cb = 128 + cs·(B − Y')/(2(1 − kb)); Cr likewise.
  const yr = ys * kr, yg = ys * kg, yb = ys * kb;
  const ub = cs / 2, ur = (-cs * kr) / (2 * (1 - kb)), ug = (-cs * kg) / (2 * (1 - kb));
  const vr = cs / 2, vg = (-cs * kg) / (2 * (1 - kr)), vb = (-cs * kb) / (2 * (1 - kr));

  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    out[i] = 16.5 + yr * rgb[p + r] + yg * rgb[p + g] + yb * rgb[p + b];
  }

  const cw = (width + 1) >> 1;
  const ch = (height + 1) >> 1;
  const u = width * height;
  const v = u + cw * ch;
  for (let cy = 0; cy < ch; cy++) {
    const row0 = 2 * cy * width;
    const row1 = Math.min(2 * cy + 1, height - 1) * width;
    for (let cx = 0; cx < cw; cx++) {
      const x0 = 2 * cx;
      const x1 = Math.min(x0 + 1, width - 1);
      const p00 = 4 * (row0 + x0), p01 = 4 * (row0 + x1), p10 = 4 * (row1 + x0), p11 = 4 * (row1 + x1);
      const R = (rgb[p00 + r] + rgb[p01 + r] + rgb[p10 + r] + rgb[p11 + r]) / 4;
      const G = (rgb[p00 + g] + rgb[p01 + g] + rgb[p10 + g] + rgb[p11 + g]) / 4;
      const B = (rgb[p00 + b] + rgb[p01 + b] + rgb[p10 + b] + rgb[p11 + b]) / 4;
      const o = cy * cw + cx;
      out[u + o] = 128.5 + ur * R + ug * G + ub * B;
      out[v + o] = 128.5 + vr * R + vg * G + vb * B;
    }
  }
}

async function transcode(codec, config, samples, frameLimit, bpp) {
  const target = Math.min(frameLimit, samples.length);
  // Frames come out in presentation order; with B-frames the first `target`
  // presented frames need a few more samples in decode order.
  const feed = Math.min(samples.length, target + 16);

  const decoderConfig = { ...config, hardwareAcceleration: "prefer-software" };
  if (!(await VideoDecoder.isConfigSupported(decoderConfig)).supported) {
    throw new Error(`VideoDecoder does not support ${config.codec}`);
  }

  const codestreams = [];
  let colorSpace = null;
  let image = null;
  let i420 = null;
  const converter = new FrameConverter();
  let encodeTime = 0;
  let encodedBytes = 0;
  let failure = null;
  let chain = Promise.resolve();
  const begin = performance.now();

  async function encodeFrame(frame) {
    try {
      if (failure || codestreams.length >= target) return;
      if (!image) {
        const { width, height } = frame.visibleRect;
        image = { width, height, bitDepth: 8, format: "yuv420" };
        const layout = codec.encoderConfig(image, { bpp });
        const planesSize = layout.components.reduce((n, c) => n + c.byteSize, 0);
        i420 = new Uint8Array(planesSize);
      }
      // Keep the colorimetry of the encoded frames for rendering (null
      // fields: BT.709, limited range).
      colorSpace = await converter.convert(frame, i420);
      const t0 = performance.now();
      const cs = codec.encode({ ...image, data: i420 }, { bpp });
      encodeTime += performance.now() - t0;
      encodedBytes += cs.length;
      codestreams.push(cs);
      setStatus(
        "transcode",
        `${codestreams.length} / ${target} frames, ${(encodeTime / codestreams.length).toFixed(1)} ms/frame encode, ${mib(encodedBytes)}`,
      );
    } catch (e) {
      failure ??= e;
    } finally {
      frame.close();
    }
  }

  const decoder = new VideoDecoder({
    output(frame) {
      chain = chain.then(() => encodeFrame(frame));
    },
    error(e) {
      failure ??= e;
    },
  });
  decoder.configure(decoderConfig);

  let outstanding = 0;
  for (let i = 0; i < feed && !failure; i++) {
    // Keep only a few frames in flight: encoding is the slow part.
    while (decoder.decodeQueueSize > 4) {
      await new Promise((ok) => decoder.addEventListener("dequeue", ok, { once: true }));
    }
    if (++outstanding % 8 === 0) await chain;
    decoder.decode(new EncodedVideoChunk(samples[i]));
  }
  if (!failure) await decoder.flush();
  await chain;
  decoder.close();
  if (failure) throw failure;

  const seconds = (performance.now() - begin) / 1000;
  const { width, height } = image;
  const rawSize = (width * height * 3) / 2;
  const avgBpp = (8 * encodedBytes) / codestreams.length / (width * height);
  setStatus(
    "transcode",
    `${codestreams.length} frames in ${seconds.toFixed(1)} s, ` +
      `${(encodeTime / codestreams.length).toFixed(1)} ms/frame encode, ` +
      `${mib(encodedBytes)} (${avgBpp.toFixed(2)} bpp, ${((rawSize * codestreams.length) / encodedBytes).toFixed(1)}:1)`,
  );
  return { codestreams, colorSpace };
}
