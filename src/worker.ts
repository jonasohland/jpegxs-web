// Worker entry: owns one JxsCodec and serves requests from JxsWorkerClient.
import { JxsCodec } from "./codec.js";
import type { Request, Response } from "./protocol.js";
import { JxsError } from "./types.js";

interface WorkerScope {
  onmessage: ((ev: MessageEvent<Request>) => void) | null;
  postMessage(message: Response, transfer?: Transferable[]): void;
}
const scope = globalThis as unknown as WorkerScope;

let codec: JxsCodec | null = null;

function handle(req: Request): [unknown, Transferable[]] | Promise<[unknown, Transferable[]]> {
  if (req.op === "init") {
    const { wasmUrl, ...options } = req.options;
    return JxsCodec.create({
      ...options,
      ...(wasmUrl ? { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path) } : {}),
    }).then((c) => {
      codec = c;
      return [c.variant, []];
    });
  }
  if (!codec) throw new Error("JxsCodec not initialized");
  switch (req.op) {
    case "probe":
      return [codec.probe(req.data, req.options), []];
    case "decode": {
      const image = codec.decode(req.data, req.options);
      return [image, [image.data.buffer]];
    }
    case "encode": {
      const out = codec.encode(req.image, req.options);
      return [out, [out.buffer]];
    }
    case "encoderConfig":
      return [codec.encoderConfig(req.image, req.options), []];
    case "dispose":
      codec.dispose();
      codec = null;
      return [null, []];
  }
}

// Requests are handled one at a time in arrival order; codec calls are
// synchronous, so only init can interleave and the client awaits it first.
scope.onmessage = async (ev) => {
  const req = ev.data;
  try {
    const [result, transfer] = await handle(req);
    scope.postMessage({ id: req.id, ok: true, result }, transfer);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    scope.postMessage({
      id: req.id,
      ok: false,
      error: { name: err.name, message: err.message, ...(e instanceof JxsError ? { code: e.code } : {}) },
    });
  }
};
