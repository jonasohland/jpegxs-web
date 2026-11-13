import type { JxsCodecOptions } from "./codec.js";
import type { DecodeOptions, EncodeImage, EncodeOptions } from "./types.js";

/** Codec options that survive structured cloning (no functions). */
export type WorkerCodecOptions = Omit<JxsCodecOptions, "locateFile"> & {
  /** URL of jxs.wasm, if it is not next to jxs.mjs. */
  wasmUrl?: string;
};

export type Request =
  | { id: number; op: "init"; options: WorkerCodecOptions }
  | { id: number; op: "probe"; data: Uint8Array; options: DecodeOptions }
  | { id: number; op: "decode"; data: Uint8Array; options: DecodeOptions }
  | { id: number; op: "encode"; image: EncodeImage; options: EncodeOptions }
  | { id: number; op: "encoderConfig"; image: Omit<EncodeImage, "planes" | "data">; options: EncodeOptions }
  | { id: number; op: "dispose" };

export type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { name: string; message: string; code?: number } };
