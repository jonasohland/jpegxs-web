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

### Phase 2 — JS-facing wrapper (this repo)

- Thin C shim with plain exported functions (no embind) plus a hand-written
  TypeScript wrapper.
- The shim drives init → send → get → close and exposes:
  - `probe(bytes)` → image config (`svt_jpeg_xs_decoder_get_single_frame_size`)
  - `decode(bytes)` → planes
  - `encode(planes, { bpp, ... })` → codestream
- Promise-based API running in a Worker; planes copied directly into and out
  of the wasm heap.

### Phase 3 — Nix package + checks

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
