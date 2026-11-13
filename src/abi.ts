// Mirrors the constants of csrc/jxs.c and the SVT-JPEG-XS API headers.

/** The emscripten module produced by CMakeLists.txt (dist/jxs.mjs). */
export interface JxsModule {
  wasmMemory: WebAssembly.Memory;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _jxs_info_len(): number;
  _jxs_enc_params_len(): number;
  _jxs_api_version(): number;
  _jxs_probe(buf: number, len: number, proxy: number, info: number): number;
  _jxs_decoder_open(
    buf: number,
    len: number,
    proxy: number,
    threads: number,
    verbose: number,
    info: number,
    out: number,
  ): number;
  _jxs_decoder_decode(dec: number, buf: number, len: number, planes: number, planesSize: number): number;
  _jxs_decoder_close(dec: number): void;
  _jxs_encoder_config(params: number, info: number): number;
  _jxs_encoder_open(params: number, info: number, out: number): number;
  _jxs_encoder_encode(
    enc: number,
    planes: number,
    planesSize: number,
    out: number,
    outCap: number,
    outUsed: number,
  ): number;
  _jxs_encoder_close(enc: number): void;
}

export interface JxsModuleArgs {
  /** Number of pthread workers spawned up front (see CMakeLists.txt). */
  jxsThreadPoolSize?: number;
  locateFile?: (path: string, prefix: string) => string;
  wasmBinary?: ArrayBuffer;
  print?: (s: string) => void;
  printErr?: (s: string) => void;
}

// uint32_t info array layout
export const INFO_WIDTH = 0;
export const INFO_HEIGHT = 1;
export const INFO_BIT_DEPTH = 2;
export const INFO_FORMAT = 3;
export const INFO_COMPONENTS = 4;
export const INFO_FRAME_SIZE = 5;
export const INFO_PLANES_SIZE = 6;
export const INFO_COMP = 8;
export const MAX_COMPONENTS = 4;
export const INFO_LEN = INFO_COMP + 3 * MAX_COMPONENTS;

// int32_t encoder parameter array layout
export const ENC_WIDTH = 0;
export const ENC_HEIGHT = 1;
export const ENC_BIT_DEPTH = 2;
export const ENC_FORMAT = 3;
export const ENC_BPP_NUMERATOR = 4;
export const ENC_BPP_DENOMINATOR = 5;
export const ENC_DECOMP_V = 6;
export const ENC_DECOMP_H = 7;
export const ENC_QUANTIZATION = 8;
export const ENC_SLICE_HEIGHT = 9;
export const ENC_THREADS = 10;
export const ENC_CPU_PROFILE = 11;
export const ENC_CODING_SIGNS = 12;
export const ENC_CODING_SIGNIFICANCE = 13;
export const ENC_RATE_CONTROL = 14;
export const ENC_CODING_VPRED = 15;
export const ENC_VERBOSE = 16;
export const ENC_PARAMS_LEN = 17;

export const API_VERSION = (0 << 16) | 10;

// ColourFormat_t
export const COLOUR_FORMATS = {
  yuv400: 1,
  yuv420: 2,
  yuv422: 3,
  yuv444: 4, // also planar RGB
  "4-components": 5,
  gray: 6,
  "packed-rgb": 21, // packed 8-bit RGB/BGR, encoder input only
} as const;

// proxy_mode_t
export const PROXY_MODES = { full: 0, half: 1, quarter: 2 } as const;

// SvtJxsErrorType_t (int32)
export const ERRORS: Record<number, string> = {
  [0x40001001]: "InvalidApiVersion",
  [0x4000100c]: "CorruptFrame",
  [0x80001000 | 0]: "InsufficientResources",
  [0x80001001 | 0]: "Undefined",
  [0x80001004 | 0]: "InvalidComponent",
  [0x80001005 | 0]: "BadParameter",
  [0x80002012 | 0]: "DestroyThreadFailed",
  [0x80002021 | 0]: "SemaphoreUnresponsive",
  [0x80002022 | 0]: "DestroySemaphoreFailed",
  [0x80002030 | 0]: "CreateMutexFailed",
  [0x80002031 | 0]: "MutexUnresponsive",
  [0x80002032 | 0]: "DestroyMutexFailed",
  [0x80002033 | 0]: "EmptyQueue",
  [0x80002034 | 0]: "FifoShutdown",
  [0x80002035 | 0]: "EncodeFrameError",
  [0x80003000 | 0]: "DecoderInvalidPointer",
  [0x80003001 | 0]: "DecoderInvalidBitstream",
  [0x80003002 | 0]: "DecoderInternal",
  [0x80003003 | 0]: "DecoderBitstreamTooShort",
  [0x80003004 | 0]: "DecoderConfigChange",
  [0x80003005 | 0]: "DecoderEndOfCodestream",
};

export const ERR_DECODER_CONFIG_CHANGE = 0x80003004 | 0;
