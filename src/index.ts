// Browser entry: Promise-based codec in a Worker. The synchronous JxsCodec
// (for node or your own worker) lives in "jpegxs-web/codec".
export { JxsWorkerClient, createJxsWorker, type JxsWorkerOptions, type TransferOption } from "./client.js";
export type { WorkerCodecOptions } from "./protocol.js";
export * from "./types.js";
