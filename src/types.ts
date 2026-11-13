import { COLOUR_FORMATS, ERRORS, PROXY_MODES } from "./abi.js";

export type ColourFormat = keyof typeof COLOUR_FORMATS;
export type ProxyMode = keyof typeof PROXY_MODES;

/** Samples of one component: 8-bit for bit depth <= 8, otherwise 16-bit. */
export type Plane = Uint8Array | Uint16Array;

export interface ComponentInfo {
  width: number;
  height: number;
  /** Size of the tightly packed plane in bytes. */
  byteSize: number;
}

export interface ImageInfo {
  width: number;
  height: number;
  bitDepth: number;
  format: ColourFormat;
  components: ComponentInfo[];
}

export interface ProbeResult extends ImageInfo {
  /** Size in bytes of the first frame's codestream. */
  frameSize: number;
}

export interface DecodeOptions {
  /** Decode at full, half or quarter resolution. Default "full". */
  proxy?: ProxyMode;
}

export interface DecodedImage extends ImageInfo {
  /** All planes, contiguous and tightly packed, in component order. */
  data: Uint8Array;
  /** One view per component into `data`. */
  planes: Plane[];
}

export interface EncodeImage {
  width: number;
  height: number;
  /** Bits per sample, 8..16. Samples above 8 bits are 16-bit little endian. */
  bitDepth: number;
  format: ColourFormat;
  /** Either one tightly packed plane per component ... */
  planes?: ArrayBufferView[];
  /** ... or all planes contiguous, in component order. */
  data?: ArrayBufferView;
}

export interface EncodeOptions {
  /**
   * Target bits per pixel. A number is interpreted like the reference
   * encoder's --bpp (2.5 → 25/10); a tuple is [numerator, denominator].
   */
  bpp: number | [number, number];
  /** Vertical decomposition levels (0..2). Default 2. */
  decompV?: number;
  /** Horizontal decomposition levels (1..5). Default 5. */
  decompH?: number;
  quantization?: "deadzone" | "uniform";
  /** Slice height in luma lines. Default 16. */
  sliceHeight?: number;
  /** "latency" (default) or "cpu". */
  cpuProfile?: "latency" | "cpu";
  /** Sign handling: 0 off (default), 1 fast, 2 full. */
  codingSigns?: 0 | 1 | 2;
  /** Significance coding. Default true. */
  codingSignificance?: boolean;
  /** Rate control mode 0..3 (see SvtJpegxsEnc.h). Default 0. */
  rateControl?: 0 | 1 | 2 | 3;
  /** Vertical prediction mode 0..4 (see SvtJpegxsEnc.h). Default 0. */
  verticalPrediction?: 0 | 1 | 2 | 3 | 4;
}

export class JxsError extends Error {
  /** The SvtJxsErrorType_t value. */
  readonly code: number;

  constructor(code: number, context: string) {
    const name = ERRORS[code] ?? `0x${(code >>> 0).toString(16)}`;
    super(`${context}: ${name}`);
    this.name = "JxsError";
    this.code = code;
  }
}
