import * as abi from "./abi.js";
import type { JxsModule, JxsModuleArgs } from "./abi.js";
import {
  type ColourFormat,
  type ComponentInfo,
  type DecodedImage,
  type DecodeOptions,
  type EncodeImage,
  type EncodeOptions,
  type ImageInfo,
  type Plane,
  type ProbeResult,
  JxsError,
} from "./types.js";

/**
 * Which wasm build to load:
 * - `"threads"`: `jxs.wasm`, built with pthreads. Needs `SharedArrayBuffer`, so
 *   in a browser the page must be cross-origin isolated.
 * - `"single"`: `jxs-st.wasm`, without threads. Works on any page, decodes on
 *   the calling thread (like `threads: 3`, one slice worker) and cannot encode.
 * - `"auto"` (default): `"threads"` if `SharedArrayBuffer` is usable,
 *   otherwise `"single"`.
 */
export type JxsVariant = "auto" | "threads" | "single";

export interface JxsCodecOptions {
  /** See {@link JxsVariant}. */
  variant?: JxsVariant;
  /**
   * Codec threads per encoder/decoder instance. Defaults to the number of
   * logical cores, capped at 8. Ignored by the single-threaded variant.
   */
  threads?: number;
  /** SVT verbosity (0 = silent, see VerboseMessages in SvtJpegxs.h). */
  verbose?: number;
  /**
   * Passed to emscripten, e.g. to serve jxs.wasm / jxs-st.wasm from another
   * location.
   */
  locateFile?: (path: string, prefix: string) => string;
  /** Fetched bytes of the selected variant's .wasm file. */
  wasmBinary?: ArrayBuffer;
}

/** Whether the threaded build can run here (shared wasm memory). */
export function threadsSupported(): boolean {
  if (typeof SharedArrayBuffer === "undefined") return false;
  // Browsers expose SharedArrayBuffer only on cross-origin isolated pages,
  // but check explicitly in case it is polyfilled or exposed anyway.
  const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
  return isolated !== false;
}

function resolveVariant(variant: JxsVariant = "auto"): "threads" | "single" {
  if (variant === "auto") return threadsSupported() ? "threads" : "single";
  if (variant !== "threads" && variant !== "single") throw new RangeError(`unknown variant: ${String(variant)}`);
  return variant;
}

const FORMAT_NAMES = new Map<number, ColourFormat>(
  Object.entries(abi.COLOUR_FORMATS).map(([k, v]) => [v, k as ColourFormat]),
);

function defaultThreads(): number {
  const n = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency ?? 4;
  return Math.max(1, Math.min(n, 8));
}

/** Converts a decimal bpp like the reference encoder app (2.5 → 25/10). */
export function bppFraction(bpp: number | [number, number]): [number, number] {
  if (Array.isArray(bpp)) return bpp;
  if (!(bpp > 0) || !Number.isFinite(bpp)) throw new RangeError(`invalid bpp: ${bpp}`);
  const [int, frac = ""] = String(bpp).split(".");
  if (/e/i.test(String(bpp)) || frac.length > 6) throw new RangeError(`bpp needs at most 6 decimals: ${bpp}`);
  const den = 10 ** frac.length;
  return [Number(int) * den + Number(frac || 0), den];
}

function toBytes(v: ArrayBufferView): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

/** A malloc'ed region that only grows. */
class HeapBuffer {
  ptr = 0;
  size = 0;
  private readonly mod: JxsModule;
  constructor(mod: JxsModule) {
    this.mod = mod;
  }
  reserve(size: number): number {
    if (size > this.size) {
      this.free();
      this.ptr = this.mod._malloc(size);
      if (!this.ptr) throw new JxsError(0x80001000 | 0, "malloc");
      this.size = size;
    }
    return this.ptr;
  }
  free(): void {
    if (this.ptr) this.mod._free(this.ptr);
    this.ptr = 0;
    this.size = 0;
  }
}

interface DecoderState {
  handle: number;
  proxy: number;
  info: Uint32Array;
}

interface EncoderState {
  handle: number;
  params: Int32Array;
  info: Uint32Array;
}

/**
 * Synchronous JPEG XS encoder/decoder on top of the wasm module.
 *
 * Calls block until the frame is done (with the threaded variant, until the
 * codec's worker threads are done), so in a browser this should run inside a
 * Worker (see createJxsWorker). In node it can be used
 * directly.
 *
 * The last used decoder and encoder are kept open and reused while the stream
 * shape / encoder parameters stay the same.
 */
export class JxsCodec {
  /** The wasm build in use. */
  readonly variant: "threads" | "single";
  private readonly mod: JxsModule;
  private readonly threads: number;
  private readonly verbose: number;
  private readonly scratch: number;
  private readonly input: HeapBuffer;
  private readonly output: HeapBuffer;
  private decoder: DecoderState | null = null;
  private encoder: EncoderState | null = null;
  private disposed = false;

  static async create(options: JxsCodecOptions = {}): Promise<JxsCodec> {
    const variant = resolveVariant(options.variant);
    const threads = variant === "single" ? 1 : Math.max(1, Math.floor(options.threads ?? defaultThreads()));
    const args: JxsModuleArgs = {};
    // Each pipeline uses at most max(threads, 4) threads; one decoder and one
    // encoder may be open at the same time.
    if (variant === "threads") args.jxsThreadPoolSize = 2 * Math.max(threads, 4);
    if (options.locateFile) args.locateFile = options.locateFile;
    if (options.wasmBinary) args.wasmBinary = options.wasmBinary;
    const { default: createJxsModule } = variant === "threads" ? await import("./jxs.mjs") : await import("./jxs-st.mjs");
    const mod = (await createJxsModule(args)) as JxsModule;
    return new JxsCodec(mod, variant, threads, options.verbose ?? 0);
  }

  private constructor(mod: JxsModule, variant: "threads" | "single", threads: number, verbose: number) {
    if (mod._jxs_api_version() !== abi.API_VERSION) throw new Error("jxs.wasm API version mismatch");
    if (mod._jxs_info_len() !== abi.INFO_LEN || mod._jxs_enc_params_len() !== abi.ENC_PARAMS_LEN) {
      throw new Error("jxs.wasm ABI mismatch");
    }
    this.mod = mod;
    this.variant = variant;
    this.threads = threads;
    this.verbose = verbose;
    // info array | encoder params | pointer/size out-param
    this.scratch = mod._malloc(4 * (abi.INFO_LEN + abi.ENC_PARAMS_LEN + 1));
    this.input = new HeapBuffer(mod);
    this.output = new HeapBuffer(mod);
  }

  private get infoPtr(): number {
    return this.scratch;
  }
  private get paramsPtr(): number {
    return this.scratch + 4 * abi.INFO_LEN;
  }
  private get outPtr(): number {
    return this.scratch + 4 * (abi.INFO_LEN + abi.ENC_PARAMS_LEN);
  }

  // Views must be created per access: the memory may have grown (and with
  // shared memory, a grown buffer is a new SharedArrayBuffer object).
  private u8(ptr: number, len: number): Uint8Array {
    return new Uint8Array(this.mod.wasmMemory.buffer, ptr, len);
  }
  private readInfo(): Uint32Array {
    return new Uint32Array(this.mod.wasmMemory.buffer, this.infoPtr, abi.INFO_LEN).slice();
  }
  private readOut(): number {
    return new Uint32Array(this.mod.wasmMemory.buffer, this.outPtr, 1)[0]!;
  }

  private check(err: number, context: string): void {
    if (err !== 0) throw new JxsError(err, context);
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error("JxsCodec has been disposed");
  }

  private copyIn(data: Uint8Array): number {
    const ptr = this.input.reserve(data.length);
    this.u8(ptr, data.length).set(data);
    return ptr;
  }

  /** Reads the image configuration of the first frame in `data`. */
  probe(data: Uint8Array, options: DecodeOptions = {}): ProbeResult {
    this.assertAlive();
    const proxy = abi.PROXY_MODES[options.proxy ?? "full"];
    const ptr = this.copyIn(data);
    this.check(this.mod._jxs_probe(ptr, data.length, proxy, this.infoPtr), "probe");
    const info = this.readInfo();
    return { ...infoToImage(info), frameSize: info[abi.INFO_FRAME_SIZE]! };
  }

  /** Decodes the first frame in `data`. */
  decode(data: Uint8Array, options: DecodeOptions = {}): DecodedImage {
    this.assertAlive();
    const proxy = abi.PROXY_MODES[options.proxy ?? "full"];
    const inPtr = this.copyIn(data);

    this.check(this.mod._jxs_probe(inPtr, data.length, proxy, this.infoPtr), "decode");
    const probed = this.readInfo();
    let dec = this.decoder;
    if (!dec || dec.proxy !== proxy || !sameShape(dec.info, probed)) {
      dec = this.openDecoder(inPtr, data.length, proxy);
    }

    let err = this.runDecode(dec, inPtr, data.length);
    if (err === abi.ERR_DECODER_CONFIG_CHANGE) {
      // Same image shape but different coding parameters.
      dec = this.openDecoder(inPtr, data.length, proxy);
      err = this.runDecode(dec, inPtr, data.length);
    }
    this.check(err, "decode");

    const size = dec.info[abi.INFO_PLANES_SIZE]!;
    const bytes = this.u8(this.output.ptr, size).slice();
    const image = infoToImage(dec.info);
    return { ...image, data: bytes, planes: splitPlanes(bytes, image) };
  }

  private openDecoder(inPtr: number, len: number, proxy: number): DecoderState {
    this.closeDecoder();
    const err = this.mod._jxs_decoder_open(inPtr, len, proxy, this.threads, this.verbose, this.infoPtr, this.outPtr);
    this.check(err, "decoder init");
    this.decoder = { handle: this.readOut(), proxy, info: this.readInfo() };
    return this.decoder;
  }

  private runDecode(dec: DecoderState, inPtr: number, len: number): number {
    const size = dec.info[abi.INFO_PLANES_SIZE]!;
    const outPtr = this.output.reserve(size);
    return this.mod._jxs_decoder_decode(dec.handle, inPtr, len, outPtr, size);
  }

  /** Layout of the input planes and the codestream size for an encode. */
  encoderConfig(image: Omit<EncodeImage, "planes" | "data">, options: EncodeOptions): ImageInfo & { frameSize: number } {
    this.assertAlive();
    this.writeParams(image, options);
    this.check(this.mod._jxs_encoder_config(this.paramsPtr, this.infoPtr), "encoder config");
    const info = this.readInfo();
    return { ...infoToImage(info), frameSize: info[abi.INFO_FRAME_SIZE]! };
  }

  /** Encodes one frame and returns its codestream. Needs the `"threads"` variant. */
  encode(image: EncodeImage, options: EncodeOptions): Uint8Array {
    this.assertAlive();
    if (this.variant === "single") {
      throw new Error("encoding needs the threaded variant (SharedArrayBuffer, cross-origin isolated page)");
    }
    const params = this.writeParams(image, options);
    let enc = this.encoder;
    if (!enc || !params.every((v, i) => v === enc!.params[i])) {
      this.closeEncoder();
      const err = this.mod._jxs_encoder_open(this.paramsPtr, this.infoPtr, this.outPtr);
      this.check(err, "encoder init");
      enc = this.encoder = { handle: this.readOut(), params, info: this.readInfo() };
    }

    const info = enc.info;
    const planesSize = info[abi.INFO_PLANES_SIZE]!;
    const frameSize = info[abi.INFO_FRAME_SIZE]!;
    const inPtr = this.input.reserve(planesSize);
    if (image.data) {
      const bytes = toBytes(image.data);
      if (bytes.length !== planesSize) {
        throw new RangeError(`encode: expected ${planesSize} bytes of image data, got ${bytes.length}`);
      }
      this.u8(inPtr, planesSize).set(bytes);
    } else if (image.planes) {
      const n = info[abi.INFO_COMPONENTS]!;
      if (image.planes.length !== n) throw new RangeError(`encode: expected ${n} planes, got ${image.planes.length}`);
      let offset = 0;
      for (let c = 0; c < n; c++) {
        const bytes = toBytes(image.planes[c]!);
        const size = info[abi.INFO_COMP + 3 * c + 2]!;
        if (bytes.length !== size) throw new RangeError(`encode: plane ${c} must be ${size} bytes, got ${bytes.length}`);
        this.u8(inPtr + offset, size).set(bytes);
        offset += size;
      }
    } else {
      throw new TypeError("encode: image needs `planes` or `data`");
    }

    const outPtr = this.output.reserve(frameSize);
    const err = this.mod._jxs_encoder_encode(enc.handle, inPtr, planesSize, outPtr, frameSize, this.outPtr);
    this.check(err, "encode");
    return this.u8(outPtr, this.readOut()).slice();
  }

  private writeParams(image: Omit<EncodeImage, "planes" | "data">, o: EncodeOptions): Int32Array {
    const format = abi.COLOUR_FORMATS[image.format];
    if (format === undefined) throw new RangeError(`unknown format: ${image.format}`);
    const [num, den] = bppFraction(o.bpp);
    const p = new Int32Array(abi.ENC_PARAMS_LEN).fill(-1);
    p[abi.ENC_WIDTH] = image.width;
    p[abi.ENC_HEIGHT] = image.height;
    p[abi.ENC_BIT_DEPTH] = image.bitDepth;
    p[abi.ENC_FORMAT] = format;
    p[abi.ENC_BPP_NUMERATOR] = num;
    p[abi.ENC_BPP_DENOMINATOR] = den;
    if (o.decompV !== undefined) p[abi.ENC_DECOMP_V] = o.decompV;
    if (o.decompH !== undefined) p[abi.ENC_DECOMP_H] = o.decompH;
    if (o.quantization !== undefined) p[abi.ENC_QUANTIZATION] = o.quantization === "uniform" ? 1 : 0;
    if (o.sliceHeight !== undefined) p[abi.ENC_SLICE_HEIGHT] = o.sliceHeight;
    p[abi.ENC_THREADS] = this.threads;
    if (o.cpuProfile !== undefined) p[abi.ENC_CPU_PROFILE] = o.cpuProfile === "cpu" ? 1 : 0;
    if (o.codingSigns !== undefined) p[abi.ENC_CODING_SIGNS] = o.codingSigns;
    if (o.codingSignificance !== undefined) p[abi.ENC_CODING_SIGNIFICANCE] = o.codingSignificance ? 1 : 0;
    if (o.rateControl !== undefined) p[abi.ENC_RATE_CONTROL] = o.rateControl;
    if (o.verticalPrediction !== undefined) p[abi.ENC_CODING_VPRED] = o.verticalPrediction;
    p[abi.ENC_VERBOSE] = this.verbose;
    new Int32Array(this.mod.wasmMemory.buffer, this.paramsPtr, abi.ENC_PARAMS_LEN).set(p);
    return p;
  }

  private closeDecoder(): void {
    if (this.decoder) this.mod._jxs_decoder_close(this.decoder.handle);
    this.decoder = null;
  }

  private closeEncoder(): void {
    if (this.encoder) this.mod._jxs_encoder_close(this.encoder.handle);
    this.encoder = null;
  }

  /** Closes the cached encoder/decoder and releases heap buffers. */
  dispose(): void {
    if (this.disposed) return;
    this.closeDecoder();
    this.closeEncoder();
    this.input.free();
    this.output.free();
    this.mod._free(this.scratch);
    this.disposed = true;
  }
}

function sameShape(a: Uint32Array, b: Uint32Array): boolean {
  // Everything except the frame size.
  for (let i = 0; i < abi.INFO_LEN; i++) {
    if (i !== abi.INFO_FRAME_SIZE && a[i] !== b[i]) return false;
  }
  return true;
}

function infoToImage(info: Uint32Array): ImageInfo {
  const components: ComponentInfo[] = [];
  for (let c = 0; c < info[abi.INFO_COMPONENTS]!; c++) {
    const o = abi.INFO_COMP + 3 * c;
    components.push({ width: info[o]!, height: info[o + 1]!, byteSize: info[o + 2]! });
  }
  const code = info[abi.INFO_FORMAT]!;
  const format = FORMAT_NAMES.get(code);
  if (!format) throw new Error(`unknown colour format ${code}`);
  return {
    width: info[abi.INFO_WIDTH]!,
    height: info[abi.INFO_HEIGHT]!,
    bitDepth: info[abi.INFO_BIT_DEPTH]!,
    format,
    components,
  };
}

function splitPlanes(data: Uint8Array, image: ImageInfo): Plane[] {
  const planes: Plane[] = [];
  let offset = data.byteOffset;
  for (const c of image.components) {
    planes.push(
      image.bitDepth <= 8
        ? new Uint8Array(data.buffer, offset, c.byteSize)
        : new Uint16Array(data.buffer, offset, c.byteSize / 2),
    );
    offset += c.byteSize;
  }
  return planes;
}
