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

### Phase 4 — Performance — in progress, see results below

Measured against the plain-C baseline:

1. `-O3 -msimd128` + LTO. — done
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

## Phase 4 results (in progress)

Focus: the decoder.

### Benchmark

`scripts/bench.mjs [dist-dir] [--threads 1,4] [--frames 30] [--cases ...]`
runs `JxsCodec` under node on synthetic frames (`test/image.js`). It reports
the median/min time per frame after warm-up and SHA-256 prefixes of the
codestream and decoded output, so builds can be compared for speed and
bit-exactness at once. To compare a variant, build it into its own directory
(`emcmake cmake ... -DJXS_OUTPUT_DIR=<dir> -DCMAKE_C_FLAGS=...`) and copy the
compiled TypeScript from `dist/` next to it.

Measuring pitfalls:

- **Power state.** On battery the laptop (Core Ultra 7 258V, 4 P + 4 LPE
  cores) is up to 2× slower. Compare only runs made back to back on AC.
- **One case per process.** V8 caches compiled wasm per module in-process, so
  only the first codec of a process shows "cold" behavior (see the Liftoff
  finding below). That first codec is what a real player uses. For decoder
  numbers, run one `--threads`/`--cases` combination per node process.
- `threads` is the SVT `threads_num`. The decoder runs `threads − 2`
  universal (slice) threads, at least 1, plus an init and a final thread. So
  `threads: 3` is one worker, and the tests' `threads: 4` is only two.

### Step 1: compiler flags (2026-11-13) — done

- `-O3` and `-flto` were already in place: upstream adds `-flto`, CMake's
  Release flags give `-O3`, and the link step runs at `-O3` too.
- `-fstack-protector-strong` (from upstream) has no effect on wasm: the binary
  contains no `__stack_chk_*`, and `-fno-stack-protector` gives an identical
  binary.
- `-msimd128` (clang auto-vectorization) is bit-exact (all hashes unchanged).
  It is now the root CMake option `JXS_WASM_SIMD` (default `ON`).
  `nix/svt-jpegxs-wasm.nix` has a matching `simd` argument (default `true`),
  so the `compare-apps` check covers the vectorized code. The wasm grows from
  201 KB to 232 KB. Encoding gains about 30–40% (measured on battery, so only
  indicative); decoding gains 7–20% (table below).

### Decoder profile (2026-11-13)

Tools: `node --cpu-prof` (it profiles the pthread workers too) on a build
linked with `--profiling-funcs`; `perf record` + `node --perf-prof` +
`perf inject --jit`, which also shows the V8 tier (Liftoff/TurboFan) per
function; `perf` on the native `SvtJpegxsDecApp --asm c|max`. Note that
`--cpu-prof` counts threads blocked in `Atomics.wait`
(`emscripten_futex_wait`) as busy; exclude it.

Where the single-thread decode time goes (1080p/2160p 4:2:2 10-bit, wasm,
`-msimd128`, share of decoder CPU):

| Part | wasm | native C | Functions |
|------|------|----------|-----------|
| Entropy decoding / unpacking | ~35% | ~23% | `vlc_reader_get_next_value`, `unpack_data_c`, `unpack_data_single_group`, `svt_jpeg_xs_decode_slice` |
| Dequantization | ~25% | ~23% | `dequant_c` (deadzone) |
| Inverse DWT + output scaling | ~25% | ~45% | `idwt_horizontal_line_*`, `idwt_vertical_line*`, `linear_output_scaling_16bit_line_c`, `transform_precinct*` |
| Other (JS copy-out, log2, sign) | rest | rest | |

LTO inlines most of the IDWT into `transform_precinct` /
`new_transform_component_line` in the wasm build, so the wasm attribution is
coarser. In the native AVX2 build, `unpack_data_avx2` (43%) and
`svt_jpeg_xs_decode_slice` (23%) dominate: the entropy decoding is the hardest
part to speed up.

#### Finding 1: `dequant_c` doesn't vectorize

`inv_quant_deadzone` indexes `gclis[coeff_idx / group_size]` with a runtime
`group_size`, so neither clang for wasm nor gcc for x86 vectorizes it. It is
always `GROUP_SIZE` (4) in practice (the SSE4.1 kernel asserts that).
Dispatching to a call with the constant (`Dequant.c`, 5 lines) is bit-exact
and saves 10–15% of single-thread decode time.

#### Finding 2: the slice worker loop runs as unoptimized Liftoff code

The biggest issue. `thread_universal_stage_kernel` is an endless loop that
each worker thread enters once. LTO and binaryen inline
`svt_jpeg_xs_decode_slice` (with the unpacking around it) into it. V8 starts
every wasm function in its baseline compiler (Liftoff) and swaps in TurboFan
code only on the next call; there is no on-stack replacement for wasm. So the
workers of the first decoder in a process (or page) run that code as Liftoff
forever. With several workers it gets much worse: 4 workers spend 8× as much
CPU per frame in that function as one worker, while all other functions cost
the same. Native C scales 3–3.3× from 1 to 4 workers; wasm scaled 1.9×, and
`threads: 8` was slower than `threads: 6`. `node --no-liftoff` makes the
problem disappear, which confirms the cause. A later decoder (for example
after a stream shape change) was fast, because its workers start after
tier-up. The browser (V8 too) is affected the same way.

`__attribute__((noinline))` on `svt_jpeg_xs_decode_slice` doesn't help:
binaryen's `wasm-opt -O3` inlines single-call-site functions regardless, and
`BINARYEN_EXTRA_PASSES` run after `-O3`. The fix: call it through a `volatile`
function pointer in `DecThreadSlice.c` (9 lines), which no inliner can see
through. It is bit-exact.

The same pattern (endless stage loops with inlined work) very likely affects
the decoder's init/final stage threads (they do little work) and the encoder's
stage threads. Not yet checked.

#### Results

Decode time per frame in ms on AC power. Each cell is a fresh node process
(cold, like a real player), median of 40 frames. "native" is
`SvtJpegxsDecApp --lp <threads>` on the same codestreams (app fps, includes
I/O).

| Case | threads | before `-msimd128` | `-msimd128` | + dequant | + Liftoff fix | native C | native AVX2/512 |
|------|---------|-------------------|-------------|-----------|---------------|----------|-----------------|
| 1080p 4:2:0 8-bit, bpp 3 | 3 | 26.8 | 25.0 | 21.6 | 22.3 | 17.6 | 6.8 |
| | 6 | 14.1 | 11.9 | 10.6 | 7.8 | 5.5 | 2.3 |
| | 8 | 16.4 | 14.2 | 13.0 | **5.4** | 5.0 | 1.7 |
| 1080p 4:2:2 10-bit, bpp 4 | 3 | 38.5 | 35.7 | 31.5 | 30.0 | 26.0 | 10.0 |
| | 6 | 19.7 | 16.8 | 17.0 | 11.2 | 7.8 | 3.2 |
| | 8 | 21.6 | 18.0 | 19.3 | **8.5** | 7.3 | 2.5 |
| 2160p 4:2:2 10-bit, bpp 3 | 3 | 116.7 | 105.0 | 88.8 | 87.9 | 75.7 | 29.0 |
| | 6 | 62.3 | 52.9 | 50.9 | 33.3 | 25.1 | 10.2 |
| | 8 | 79.8 | 62.7 | 60.3 | **25.8** | 22.1 | 9.0 |

With both fixes, the wasm decoder at the default `threads: 8` is 2.1–2.6×
faster than the current build and within 10–20% of native C. It is still 3×
slower than native AVX2/AVX-512.

Both fixes are uncommitted changes in the submodule (`Dequant.c`,
`DecThreadSlice.c`). `npm test` (bit-exact vs native), `test:browser` and
`nix flake check` pass with them.

### Next steps (decoder)

1. Commit the two fixes on the fork's `wasm` branch. Check the decoder's init
   and final stage loops and the encoder's stage loops for the same Liftoff
   problem.
2. Hand-written wasm SIMD kernels (step 3), in the order of what native AVX2
   gains: IDWT horizontal (`idwt_horizontal_line_lf16_hf16`, `_lf32_hf16`)
   and `linear_output_scaling_16bit_line`, then `idwt_vertical_line*`,
   `dequant` (the SSE4.1 version is a template), and `inv_sign`.
   `unpack_data` (entropy decoding) is the largest remaining part, but even
   AVX2 helps it less.
3. Step 2 (SSE → wasm SIMD translation) isn't worth it: only `dequant` among
   the decoder's kernels has an SSE version, and it is easy to write by hand.
4. Smaller items: the main-thread copy of the decoded frame out of the wasm
   heap (about 4.5 ms per 2160p frame) could be avoided by decoding into a
   caller-provided buffer or handing out a view.
