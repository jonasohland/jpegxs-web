# jpegxs-web

A JPEG XS decoder for the browser, built by compiling
[SVT-JPEG-XS](../third_party/SVT-JPEG-XS) (git submodule, fork at
`github.com/jonasohland/SVT-JPEG-XS`) to WebAssembly.

## Nix flake

The flake currently targets `x86_64-linux` only (the native SVT build uses x86
NASM assembly; `jxs-cuda` is x86_64-linux only).

The flake source includes the submodule via `inputs.self.submodules = true`, so
clone with `--recursive` or run `git submodule update --init`. Files must be
tracked by git (at least staged) to be visible to the flake.

### Inputs

| Input      | Source                                                          |
|------------|-----------------------------------------------------------------|
| `nixpkgs`  | `github:NixOS/nixpkgs/nixos-unstable`                           |
| `jxs-cuda` | `git+ssh://git@bitbucket.org/riedelcommunications/jxs-cuda.git` (follows `nixpkgs`; needs SSH access) |

### Packages

| Package                 | Description |
|-------------------------|-------------|
| `svt-jpegxs` (default)  | Native build of the SVT-JPEG-XS submodule (`nix/svt-jpegxs.nix`): shared library `libSvtJpegxs.so`, headers under `include/svt-jpegxs`, pkg-config file `SvtJpegxs.pc`, and the apps `SvtJpegxsDecApp`, `SvtJpegxsEncApp`, `SvtJpegxsSampleDecoder`, `SvtJpegxsSampleEncoder`. Serves as the reference decoder for validating the wasm build. |
| `svt-jpegxs-wasm`       | WebAssembly build of the same submodule (`nix/svt-jpegxs-wasm.nix`), configured with `emcmake` and `ENABLE_X86_ASM=OFF` (portable C code paths, pthreads). Installs the static `libSvtJpegxs.a`, headers, pkg-config file and the four apps as node CLIs (`bin/*.js` + `bin/*.wasm`, run with `node bin/SvtJpegxsDecApp.js ...`). Code linking the static library must also be compiled and linked with `-pthread`. |
| `jxs-cuda`              | CUDA JPEG XS encoder/decoder, re-exported from the `jxs-cuda` flake. Provides the `jxs` CLI. |

```sh
nix build .#svt-jpegxs   # or just: nix build
nix build .#svt-jpegxs-wasm
nix build .#jxs-cuda
```

### Overlay

`overlays.default` adds `svt-jpegxs` to nixpkgs.

### Dev shells

| Shell     | Contents |
|-----------|----------|
| `default` | emscripten, cmake, ninja, pkg-config, nodejs, typescript, binaryen, wabt, python3, and the native `svt-jpegxs` tools. |
| `cuda`    | Everything in `default`, plus `jxs-cuda` (pulls in the CUDA toolkit). |

```sh
nix develop          # or via direnv: .envrc contains `use flake`
nix develop .#cuda
```

Both shells set `EM_CACHE=$PWD/.emscripten_cache`, because emscripten's
default cache in the Nix store is read-only. They also set
`EMCC_CFLAGS=-Wno-version-check`: nixpkgs pairs emscripten 6.0.9 with
binaryen 133 (emscripten expects 132), and the resulting warning breaks the
upstream `-Werror` build.

Manual wasm build in the dev shell:

```sh
emcmake cmake -S third_party/SVT-JPEG-XS -B build/wasm -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_OUTPUT_DIRECTORY=$PWD/build/wasm/bin
ninja -C build/wasm
spike/compare.sh build/wasm/bin <work-dir>   # bit-exactness vs native
```

Set `CMAKE_OUTPUT_DIRECTORY` explicitly; otherwise upstream writes binaries
into `third_party/SVT-JPEG-XS/Bin/`.

### Formatter

`nix fmt` runs `nixfmt`.

## JS library

| Path | Contents |
|------|----------|
| `CMakeLists.txt` | Builds `dist/jxs.mjs` + `dist/jxs.wasm` (emcmake) from the submodule and the shim. |
| `csrc/jxs.c` | C shim with plain exported functions. |
| `src/` | TypeScript: `JxsCodec` (sync, `jpegxs-web/codec`), Worker + `createJxsWorker()` (Promise API, main entry). |
| `test/` | `codec.test.ts` (node, bit-exact vs native apps), `browser/` (headless Chrome). |
| `scripts/serve.mjs` | Static server with COOP/COEP headers. |

```sh
npm run build          # emcmake/ninja into build/lib, then tsc into dist/
npm test               # node tests (native comparisons need the dev shell)
npm run test:browser   # headless Chrome (CHROME=... to override)
npm run serve          # http://127.0.0.1:8080/ with cross-origin isolation
```

Browser usage (the page must send `Cross-Origin-Opener-Policy: same-origin`
and `Cross-Origin-Embedder-Policy: require-corp`):

```js
import { createJxsWorker } from "jpegxs-web";
const jxs = await createJxsWorker({ threads: 4 });
const info = await jxs.probe(bytes);
const { planes, data, width, height } = await jxs.decode(bytes, { proxy: "full" });
const codestream = await jxs.encode(
  { width, height, bitDepth: 10, format: "yuv422", planes }, { bpp: 3 });
await jxs.terminate();
```

## Status / next steps

See [plan.md](plan.md). Phases 0 (spike), 1 (build support in the fork,
branch `wasm`) and 2 (C shim + TypeScript/Worker wrapper) are done; next is
packaging and checks in Nix (Phase 3).
