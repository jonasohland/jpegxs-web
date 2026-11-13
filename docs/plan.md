# Plan: SVT-JPEG-XS encoder + decoder in WebAssembly

Goal: build the encoder and the decoder of
[SVT-JPEG-XS](../third_party/SVT-JPEG-XS) for the browser (and node), validated
bit-exactly against the native reference build (`packages.svt-jpegxs`).

## Findings in the upstream code

1. **No codec code has to be ported to run.** All SIMD kernels are selected at
   runtime through `Source/Lib/*/Codec/*_dsp_rtcd.c`, and every kernel has a C
   reference implementation. Without `ARCH_X86_64` the `SET_FUNCTIONS_X86`
   macro expands to nothing and cpuinfo-based detection is compiled out.
2. **The blockers are in CMake:**
   - the top-level `CMakeLists.txt` unconditionally calls
     `enable_language(ASM_NASM)`, defines `ARCH_X86_64=1` and adds
     `third_party/cpuinfo`;
   - `Source/Lib/CMakeLists.txt` always links all `ASM_*` object libraries;
   - flags such as `-Werror`, `-flto`, `-fstack-protector-strong`,
     `-D_FORTIFY_SOURCE=2` and `-pie -z noexecstack -z relro -z now` may not
     work with emcc.
   The only NASM code (`Log2_32_ASM`, picture operators) has C fallbacks.
3. **Threading.** Encoder and decoder are SVT-style pipelines of permanently
   running stage threads (decoder: at least init + universal + final). The API is
   `send_*` / `get_*` with optional blocking. Consequences in the browser:
   - build with `-pthread` → needs `SharedArrayBuffer` → the page must be
     cross-origin isolated (COOP/COEP headers);
   - blocking calls must not run on the main thread → run in a Worker.
   There is no single-threaded code path upstream.
4. **Pointer size.** Upstream warns "32-bit is not supported"; wasm32 has
   32-bit pointers. To be validated; the fallback is wasm64 (`-sMEMORY64`).

## Phases

### Phase 0 — Spike

Configure with `emcmake` (C paths only, `-pthread`), patching whatever is
necessary, and run `SvtJpegxsSampleDecoder` / `SvtJpegxsSampleEncoder` (or
the Enc/Dec apps) under node. Answers the wasm32 and threading questions
before anything is built on top. Results are recorded below.

### Phase 1 — Clean build support in the fork

In `github.com/jonasohland/SVT-JPEG-XS`:

- option `ENABLE_X86_ASM`, default `OFF` when `EMSCRIPTEN`, gating
  `ASM_NASM`, `ARCH_X86_64`, cpuinfo and the `ASM_*` subdirectories;
- guard flags emcc doesn't support;
- keep patches small so they rebase easily and could go upstream.

### Phase 2 — JS-facing wrapper (this repo) — done, see results below

- Thin C shim with plain exported functions (no embind) plus a hand-written
  TypeScript wrapper.
- The shim drives init → send → get → close and exposes:
  - `probe(bytes)` → image config (`svt_jpeg_xs_decoder_get_single_frame_size`)
  - `decode(bytes)` → planes
  - `encode(planes, { bpp, ... })` → codestream
- Promise-based API running in a Worker; planes copied directly into and out
  of the wasm heap.

### Phase 3 — Nix package + checks — done, see results below

- `packages.svt-jpegxs-wasm` built with emcmake.
- `checks.*` run under node:
  - decode test streams and compare byte-for-byte with native
    `SvtJpegxsDecApp`;
  - encode and compare codestreams with the native encoder (C and SIMD paths
    are expected to be bit-exact; to be confirmed).
- ~~Build the upstream gtest unit tests under node.~~ Not applicable: they
  compare x86 SIMD kernels against C (compiled with `-mavx2`), and the fork
  now refuses `BUILD_TESTING` without `ENABLE_X86_ASM`. Rely on the
  end-to-end bit-exactness checks instead.

### Phase 4 — Performance

Measured against the plain-C baseline:

1. `-O3 -msimd128` + LTO.
2. Try compiling the existing SSE2/SSE4.1 kernels via emscripten's SSE →
   wasm SIMD translation (AVX2/AVX-512 don't map well).
3. Hand-written `wasm_simd128.h` kernels for profiled hotspots (likely
   I/DWT, NLT, (de)quantization, (un)packing) as an `ARCH_WASM` entry in the
   rtcd dispatch, keeping C as the reference.

## Open decision

**Threads vs. single-threaded.** Starting with pthreads needs no codec
changes but requires cross-origin isolation for every embedding page.
Supporting non-isolated pages requires a second build that runs the stage
kernels inline (a real refactor of `DecHandle.c` / `EncHandle.c` and the stage
files).

## Phase 0 results (2026-11-13)

**Outcome: works, bit-exact, with one 4-line source fix.**

Setup (`spike/`):

- `spike/CMakeLists.txt` bypasses upstream CMake. It globs only the C sources
  (`Common/Codec`, `Common/Codec/Threads`, `Decoder/Codec`, `Encoder/Codec`) plus
  the SIMD header dirs that the rtcd files include, and builds the four apps.
  It uses `-pthread`, `-sNODERAWFS`, `-sPTHREAD_POOL_SIZE=16` and
  `-sALLOW_MEMORY_GROWTH`. Toolchain: emscripten 6.0.9, node 24.
- `spike/compare.sh <build-dir> <work-dir>` generates synthetic YUV and
  encodes/decodes it with native SIMD, native `--asm c` and wasm, then
  compares the outputs.
- `spike/0001-get_cpu_flags-non-x86.patch` is the only source change needed
  (currently uncommitted in the submodule). Upstream declares
  `get_cpu_flags()` only under `ARCH_X86_64`, but `DecHandle.c` and
  `EncHandle.c` call it unconditionally. The patch declares it always and
  returns 0 on other architectures.

Results:

| Case | Format | Encoder: wasm vs native | Decoder: wasm vs native |
|------|--------|-------------------------|-------------------------|
| a | 1920×1080 yuv420 8-bit, bpp 3 | identical | identical |
| b | 1280×720 yuv422 10-bit, bpp 4 | identical | identical |
| c | 640×480 yuv444 12-bit, bpp 6, signs=2, vpred=1 | identical | identical |
| d | 1000×600 yuv422 10-bit, bpp 2.5, rc=3, decomp 1/3 | identical | identical |

- Native C and native SIMD encoders also produce identical codestreams, so the
  C path is a valid reference and future wasm SIMD kernels must stay bit-exact.
- A build with `-sSAFE_HEAP=1 -sASSERTIONS=2 -sSTACK_OVERFLOW_CHECK=2` ran
  cases a–c cleanly with identical output. **wasm32 is fine for now**; no need
  for MEMORY64. Upstream unit tests (Phase 3) should still confirm this.
- **pthreads work as-is** under node. The pipeline threads need no changes.
- Size: about 115 KB for the decoder app's wasm (50 KB gzipped) and 129 KB for
  the encoder, before any trimming.
- Rough speed, from the app's own fps counter for 3 frames at 1080p 4:2:0
  (includes warm-up, indicative only):
  - encoder: native SIMD 31 fps, native C 22 fps, wasm 16 fps
  - decoder: native SIMD 48 fps, wasm 19 fps

Notes for Phase 1:

- Upstream CMake changes: gate NASM, `ARCH_X86_64`, cpuinfo, the `ASM_*` object
  libraries and the x86/hardening flags behind `ENABLE_X86_ASM`, and apply the
  `get_cpu_flags` fix.
- emcc warns that `-pthread` with `ALLOW_MEMORY_GROWTH` can slow down JS-side
  access to the heap. For the library build, consider a fixed or large
  `INITIAL_MEMORY` instead.
- emcc also warns `unexpected binaryen version: 133 (expected 132)` because of
  a version mismatch between nixpkgs' emscripten and binaryen. It's harmless so
  far.

## Phase 1 results (2026-11-13)

**Done.** These changes are on the fork's `wasm` branch, staged but not yet
committed:

- `common_dsp_rtcd.{c,h}`: `get_cpu_flags()` returns 0 when not on x86 (the
  Phase 0 fix).
- Top-level `CMakeLists.txt`:
  - `ENABLE_X86_ASM` (default `OFF` under Emscripten) gates NASM,
    `ARCH_X86_64`, the `ASM_*` object libraries and cpuinfo. Shared lists
    (`SVT_{COMMON,ENCODER,DECODER}_ASM_LIBS`, `SVT_CPUINFO_LIB`) and the
    helper `svt_target_objects()` feed the library and the sample apps.
  - Under Emscripten:
    - `-pthread` for compiling and linking;
    - `BUILD_SHARED_LIBS` defaults to `OFF`;
    - no `-pie -z ...` linker flags;
    - the apps are linked for node with `-sNODERAWFS -sPROXY_TO_PTHREAD
      -sEXIT_RUNTIME -sALLOW_MEMORY_GROWTH -sSTACK_SIZE=1MB` (cache variable
      `SVT_EMSCRIPTEN_APP_LINK_FLAGS`) plus `-Wno-pthreads-mem-growth`.
      emcc turns its own warnings into errors under `-Werror` and ignores
      `-Wno-error`.
  - `svt_install_app()` also installs each app's `.wasm`.
  - `BUILD_TESTING` requires `ENABLE_X86_ASM`.
- App CMakeLists use `svt_install_app()` and the shared ASM lists.

In this repo:

- `nix/svt-jpegxs-wasm.nix` and `packages.svt-jpegxs-wasm` (builds in the
  sandbox from a writable copy of emscripten's cache).
- Dev shells set `EMCC_CFLAGS=-Wno-version-check` (nixpkgs binaryen
  mismatch).

Verification:

- Upstream's own CMake build (`-Werror`, `-flto`) passes all four
  `spike/compare.sh` cases bit-exactly. So does the `nix build` output.
- `--lp 8` (more codec threads) is also bit-exact.
- The native package (`ENABLE_X86_ASM=ON`) still builds, and its SIMD output
  still matches its C output.

`spike/CMakeLists.txt` and the patch file are now obsolete. `spike/compare.sh`
should move into a Nix check in Phase 3.

## Phase 2 results (2026-11-13)

**Done.** The C shim, the TypeScript wrapper and the Worker client are in
place. The node build is bit-exact with the native apps, and the browser
Worker path matches the node build.

Layout (in this repo):

- `CMakeLists.txt` (root): `add_subdirectory(third_party/SVT-JPEG-XS)` (library
  only) plus the shim, linked to `dist/jxs.mjs` + `dist/jxs.wasm` as an ES6
  module (`-sMODULARIZE -sEXPORT_ES6`, `ENVIRONMENT=web,worker,node`,
  `FILESYSTEM=0`, memory growth up to 4 GB). The wasm is about 200 KB.
- `csrc/jxs.c`: the shim. It passes only integers and pointers. It exposes
  `jxs_probe` and handle-based `jxs_decoder_{open,decode,close}` /
  `jxs_encoder_{config,open,encode,close}`. Image info goes back in a
  `uint32_t[20]` array and encoder parameters go in as an `int32_t[17]` array
  (-1 = library default). Planes always travel as one contiguous, tightly
  packed buffer. `jxs_info_len` / `jxs_enc_params_len` / `jxs_api_version`
  let the JS side detect an ABI mismatch.
- `src/`:
  - `abi.ts` mirrors the C constants;
  - `codec.ts` holds `JxsCodec`, a synchronous codec for node or a Worker. It
    keeps the last decoder and encoder open and reuses them while the stream
    shape (checked with a probe, falling back on `DecoderConfigChange`) or the
    encoder parameters stay the same. Reuse roughly halves the per-frame time
    (1080p encode: 59 → 23 ms);
  - `worker.ts` and `client.ts` hold `createJxsWorker()` /
    `JxsWorkerClient`, which provide the Promise API with transferable
    results;
  - `index.ts` is the browser entry (client + types only); `jpegxs-web/codec`
    is the sync codec.
- bpp given as a number is converted the way EncApp does it (`2.5` → 25/10),
  so codestreams match the reference CLI exactly.

Threading:

- The codec creates its pipeline threads synchronously in init and blocks on
  them, so they must come from emscripten's pre-spawned pool.
  `PTHREAD_POOL_SIZE` is the JS expression `Module['jxsThreadPoolSize']??8`.
  `JxsCodec.create()` sets it to `2 * max(threads, 4)`, enough for one
  decoder and one encoder open at once: the decoder uses `max(threads, 3)`
  threads and the encoder at most `max(threads, 4)`.
- `PTHREAD_POOL_SIZE_STRICT=2` turns pool exhaustion into an error instead
  of a deadlock.
- `threads` defaults to `min(hardwareConcurrency, 8)`.

Tests:

- `npm test` runs `test/codec.test.ts` with node's built-in type stripping
  against `dist/`. It covers the four `spike/compare.sh` cases, proxy modes,
  decoder reuse/reopen across shape and coding changes, planes vs contiguous
  input, Uint16 planes, and error paths. When the native apps are on PATH
  (dev shell), codestreams and decoded output are compared byte-for-byte with
  `SvtJpegxsEncApp` / `SvtJpegxsDecApp`. All 13 tests pass.
- `npm run test:browser` serves the repo with COOP/COEP
  (`scripts/serve.mjs`) and runs `test/browser/index.html` in headless Chrome
  through `createJxsWorker`. It checks that the page is cross-origin isolated
  and that SHA-256 hashes of the codestreams and of the full- and
  half-resolution decodes equal the node build's. It passes. Headless Chrome
  timings: 1080p 4:2:0 decode about 54 ms, 720p 10-bit 4:2:2 encode 26 ms /
  decode 28 ms.

Open points carried into Phase 3:

- `dist/` is a build output (gitignored). Build it with `npm run build`
  (`build:wasm` + `build:ts`; `tsc` comes from the dev shell, TypeScript 7).
  The Nix package should run both and the `checks` should run `npm test`;
  `test:browser` needs Chrome and stays manual.
- Only planar formats are tested. `packed-rgb` encoder input is passed
  through but untested.
- Strides are always tight. The decoder doesn't support padded strides
  anyway.
- `spike/CMakeLists.txt` and the patch are still in the tree (obsolete since
  Phase 1).

## Phase 3 results (2026-11-13)

**Done.** `nix flake check` builds all packages and runs two bit-exactness
checks. Both pass.

Packages:

- `packages.jpegxs-web` (`nix/jpegxs-web.nix`): the npm package. It runs the
  same steps as `npm run build` (emcmake + ninja on the root
  `CMakeLists.txt`, then `tsc` from nixpkgs' TypeScript 7) on a fileset-filtered
  source. `$out` is the package directory (`package.json` + `dist/`), so it
  can be installed with `npm install <store path>`. It has no runtime
  references to the store.
- The emscripten cache/`EMCC_CFLAGS` setup is shared by both wasm derivations
  through `nix/emscripten-env.nix`.

Checks (`nix/checks.nix`; the packages themselves are also exposed as checks):

- `svt-jpegxs-wasm-apps`: `scripts/compare-apps.sh` (formerly
  `spike/compare.sh`). It encodes synthetic frames with the native apps (SIMD
  and `--asm c`) and with the wasm apps under node, decodes with both, and
  fails on any mismatch. The four Phase 0 cases are covered, plus case e
  (`--lp 8`). The native C and SIMD encoders are confirmed bit-exact in all
  cases.
- `jpegxs-web-test`: `node --test` from `test/` against the packaged `dist/`,
  with the native apps on PATH and `JXS_REQUIRE_NATIVE=1`. That makes missing
  reference apps a failure instead of silently skipping the byte-for-byte
  comparisons. All 13 tests pass in the sandbox.

Cleanup: `spike/` (the obsolete CMakeLists and patch) is removed.

Notes:

- The flake's source includes the submodule. With a clean tree, Nix fetches
  the submodule commit from the fork's remote (`.gitmodules`), so the
  submodule commit must be pushed there. A dirty tree uses the local
  checkout.
- The `.js.map` files in `dist/` point at `../src/*.ts`, which the package
  does not ship. `tsconfig.json` sets `inlineSources` so the maps carry the
  TypeScript sources themselves (about 52 KB of maps in total).
- `test:browser` still needs Chrome and stays manual.
