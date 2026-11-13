import type { Request, Response, WorkerCodecOptions } from "./protocol.js";
import {
  type DecodedImage,
  type DecodeOptions,
  type EncodeImage,
  type EncodeOptions,
  type ImageInfo,
  type ProbeResult,
  JxsError,
} from "./types.js";

export interface JxsWorkerOptions extends WorkerCodecOptions {
  /** Use this worker instead of starting dist/worker.js. */
  worker?: Worker;
}

export interface TransferOption {
  /**
   * Transfer the input buffers to the worker instead of copying them. They
   * become detached (unusable) in the calling thread.
   */
  transfer?: boolean;
}

type Distribute<T> = T extends unknown ? Omit<T, "id"> : never;

/**
 * Promise-based JPEG XS codec running in a dedicated Worker.
 *
 * The threaded wasm build needs `SharedArrayBuffer`, so the page must be
 * cross-origin isolated (`Cross-Origin-Opener-Policy: same-origin` and
 * `Cross-Origin-Embedder-Policy: require-corp`). Elsewhere the default
 * `variant: "auto"` loads the single-threaded build, which decodes only.
 */
export class JxsWorkerClient {
  /** The wasm build the worker loaded (known once createJxsWorker resolves). */
  variant: "threads" | "single" | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private readonly worker: Worker;

  constructor(worker: Worker) {
    this.worker = worker;
    worker.onmessage = (ev: MessageEvent<Response>) => this.onResponse(ev.data);
    worker.onerror = (ev: ErrorEvent) => this.failAll(new Error(`jxs worker error: ${ev.message}`));
  }

  private onResponse(res: Response): void {
    const p = this.pending.get(res.id);
    if (!p) return;
    this.pending.delete(res.id);
    if (res.ok) {
      p.resolve(res.result);
    } else if (res.error.code !== undefined) {
      const err = new JxsError(res.error.code, "");
      err.message = res.error.message;
      p.reject(err);
    } else {
      const err = new Error(res.error.message);
      err.name = res.error.name;
      p.reject(err);
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private call<T>(req: Distribute<Request>, transfer: Transferable[] = []): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...req, id }, transfer);
    });
  }

  /** @internal */
  async init(options: WorkerCodecOptions): Promise<void> {
    this.variant = await this.call<"threads" | "single">({ op: "init", options });
  }

  probe(data: Uint8Array, options: DecodeOptions = {}): Promise<ProbeResult> {
    return this.call({ op: "probe", data, options });
  }

  async decode(data: Uint8Array, options: DecodeOptions & TransferOption = {}): Promise<DecodedImage> {
    const { transfer, ...opts } = options;
    const image = await this.call<DecodedImage>(
      { op: "decode", data, options: opts },
      transfer && data.buffer instanceof ArrayBuffer ? [data.buffer] : [],
    );
    // Structured cloning keeps the plane views on the shared `data` buffer.
    return image;
  }

  encode(image: EncodeImage, options: EncodeOptions & TransferOption): Promise<Uint8Array> {
    const { transfer, ...opts } = options;
    const buffers = new Set<ArrayBuffer>();
    if (transfer) {
      for (const v of [image.data, ...(image.planes ?? [])]) {
        if (v && v.buffer instanceof ArrayBuffer) buffers.add(v.buffer);
      }
    }
    return this.call({ op: "encode", image, options: opts }, [...buffers]);
  }

  encoderConfig(
    image: Omit<EncodeImage, "planes" | "data">,
    options: EncodeOptions,
  ): Promise<ImageInfo & { frameSize: number }> {
    return this.call({ op: "encoderConfig", image, options });
  }

  /** Releases the codec and terminates the worker. */
  async terminate(): Promise<void> {
    try {
      await this.call({ op: "dispose" });
    } finally {
      this.worker.terminate();
      this.failAll(new Error("jxs worker terminated"));
    }
  }
}

export async function createJxsWorker(options: JxsWorkerOptions = {}): Promise<JxsWorkerClient> {
  const { worker, ...codecOptions } = options;
  const w = worker ?? new Worker(new URL("./worker.js", import.meta.url), { type: "module", name: "jxs" });
  const client = new JxsWorkerClient(w);
  try {
    await client.init(codecOptions);
  } catch (e) {
    w.terminate();
    throw e;
  }
  return client;
}
