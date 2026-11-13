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
2. ~~Try compiling the existing SSE2/SSE4.1 kernels via emscripten's SSE →
   wasm SIMD translation.~~ Dropped: the decoder has a single SSE kernel
   (`dequant`), now written by hand.
3. Hand-written `wasm_simd128.h` kernels for profiled hotspots (likely
   I/DWT, NLT, (de)quantization, (un)packing) as a `CPU_FLAGS_WASM_SIMD128`
   entry in the rtcd dispatch, keeping C as the reference. — in progress
   (`dequant` done)

### Phase 5 — Single-threaded fallback for non-isolated pages (investigation)

After the performance work. The pthreads build needs `SharedArrayBuffer`, so
it only runs on cross-origin isolated pages (COOP/COEP). Investigate a second
build without `-pthread` that the JS side picks when `crossOriginIsolated` is
false. Decoder first; the encoder only if it comes cheaply.

Questions to answer:

- **How to run the pipeline without threads.** Upstream has no
  single-threaded path: the init → universal → final stage threads talk through
  FIFOs and condition variables. Options:
  - drive the stage functions inline from the shim, slice by slice (parse
    header, `svt_jpeg_xs_decode_slice` per slice in order, then the final
    slice-overlap/IDWT step), bypassing the threads and FIFOs;
  - a build-time switch in the fork that replaces `SVT_CREATE_THREAD` and the
    blocking FIFO calls with inline execution;
  - a refactor of `DecHandle.c` and the stage files (largest, most invasive).
  Check how much of this upstream would accept, so the fork stays rebaseable.
- **Bit-exactness.** The output must match the threaded build and the native
  apps. Add the non-threaded build to `npm test` and the Nix checks.
- **Cost.** Expected speed is roughly the one-worker numbers (`threads: 3`
  in the Phase 4 table), minus the hand-off overhead. Measure it, and the
  extra download size of a second `jxs.wasm`.
- **Packaging and API.** Two wasm/glue pairs in `dist/`, chosen at runtime in
  `createJxsWorker()` / `JxsCodec.create()`, behind the same API. The fallback
  still runs in a Worker so the main thread doesn't block. Without
  `SharedArrayBuffer`, results can still be transferred.
- **Phase 4 carry-over.** The Liftoff issue (endless loops entered once) may
  look different without threads; re-check that the hot code tiers up.

## Open decision

**Threads vs. single-threaded.** Starting with pthreads needs no codec
changes but requires cross-origin isolation for every embedding page.
Supporting non-isolated pages requires a second build that runs the stage
kernels inline (a real refactor of `DecHandle.c` / `EncHandle.c` and the stage
files). To be investigated in Phase 5.

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

Both fixes are in the fork as commit `10a93c0`. `npm test` (bit-exact vs native), `test:browser` and
`nix flake check` pass with them.

### Step 3: wasm SIMD kernels (2026-11-13) — in progress

Infrastructure (in the fork; the two fixes above are commit `10a93c0`, this is
uncommitted on top):

- `CPU_FLAGS_WASM_SIMD128` (`1 << 16`) in `SvtJpegxs.h`; `CPU_FLAGS_ALL` now
  includes it. `get_cpu_flags()` reports it when the build has
  `__wasm_simd128__` (an engine without SIMD rejects the module anyway), and
  `get_asm_level_name_str()` knows it as `wasm_simd128`. `--asm c` /
  `use_cpu_flags = 0` still select the C kernels, so both paths can be
  checked in the same wasm binary.
- Kernels live in `Source/Lib/Decoder/ASM_WASM_SIMD128/` (object library
  `DECODER_ASM_WASM_SIMD128`, added to `SVT_DECODER_ASM_LIBS` under
  Emscripten). The sources are wrapped in `#ifdef __wasm_simd128__`, so they
  are empty without `-msimd128`.
- `decoder_dsp_rtcd.c`: `SET_WASM_SIMD128(ptr, fn)` overrides an entry after
  the usual `SET_*` macro when the flag is set.
- Tests: `scripts/compare-apps.sh` also decodes with the wasm app's
  `--asm c` and compares both wasm decodes with native; new cases f and g
  (uniform quantization; g has odd sizes, 1918×1078 4:4:4 12-bit, for partial
  groups). `test/codec.test.ts` has a matching uniform case (e). All pass,
  as do `test:browser` and `nix flake check`.

**`dequant_wasm_simd128`**: deadzone (the default) does 16 coefficients
(4 groups) per iteration. It widens the group masks from the `gcli` bytes
with one `i8x16.shuffle`, ORs in `1 << (gtli - 1)` where the group is above
`gtli` and the coefficient is non-zero. Uniform works per group of 4 like the
SSE4.1 version. It is bit-exact with the C version, including corner cases:
`gcli` is compared as `int8_t`; wasm shifts count modulo 16, while C shifts an
`int`; non-`GROUP_SIZE` groups fall back to C. In the profile, dequantization
drops from about 25% of decode CPU to 1.3%.

Decode ms per frame, fresh process each, on AC:

| Case | threads | C dequant (`10a93c0`) | `dequant_wasm_simd128` | native C | native AVX2/512 |
|------|---------|-----------------------|------------------------|----------|-----------------|
| 1080p 4:2:0 8-bit | 3 | 21.7 | 18.4 | 17.6 | 6.8 |
| | 8 | 5.5 | 4.5 | 5.0 | 1.7 |
| 1080p 4:2:2 10-bit | 3 | 31.3 | 24.3 | 26.0 | 10.0 |
| | 8 | 8.4 | 6.3 | 7.3 | 2.5 |
| 2160p 4:2:2 10-bit | 3 | 87.1 | 74.9 | 75.7 | 29.0 |
| | 8 | 24.3 | 21.4 | 22.1 | 9.0 |

The wasm decoder now matches or beats native C (whose `dequant_c` doesn't
vectorize). The remaining gap to native AVX2 is 2.5–3.7×.

### Step 3b: single-thread decoder at 60 fps (2026-11-13)

Goal: 1080p at 60 fps (16.7 ms/frame) with one decoding thread
(`threads: 3`, i.e. one slice worker; the init and final threads do little).

Profiling showed the decoder spent about 61% of the single-thread time in
entropy decoding, roughly 2.5× slower than native C for the same code. The
inverse DWT came next. Changes, all bit-exact (in the fork, uncommitted):

1. **`Packing.c`: no indirect call per VLC symbol.**
   `vlc_reader_get_next_value()` computed `32 - svt_log2_32(x)` through the
   rtcd function pointer, i.e. an indirect call into the branchy
   `log2_32_c()` on wasm (native x86 uses `Log2_32_ASM`). Now
   `__builtin_clz(x) + 1` (`x` is known to be non-zero; MSVC keeps the old
   path). −18 to −20%.
2. **`Packing.c`: inlinable VLC fast path.** The rare refill branch is now
   `vlc_reader_refill()` (`NOINLINE`). It takes and returns the reader by
   value, so the caller's reader doesn't escape: in wasm, address-taken locals
   live in linear memory. `vlc_reader_get_next_value()` is `FORCE_INLINE`. New
   `FORCE_INLINE` / `NOINLINE` macros in `Definitions.h`. About −8%,
   together with 4.
3. **`Packing.c`: `unpack_data_single_group()`** walks the nibbles with a
   local index and updates the reader once, instead of calling
   `read_4_bits_align4()` per bit plane. Small gain (about 3%) for the C path;
   superseded on wasm by 4.
4. **`unpack_data_wasm_simd128`** (`ASM_WASM_SIMD128/UnPack_wasm_simd128.c`):
   loads up to 16 nibbles of a group (the sign nibble too, with
   `sign_flag == 0`), spreads them into byte lanes in reverse order with one
   `i8x16.shuffle` and collects each coefficient's bits with
   `i8x16.bitmask` + `i8x16.add` (shift left by one), 4 times. It uses the fast
   path only if the 8-byte load stays inside the bitstream buffer, and handles
   more than 16 nibbles (corrupt streams) with a scalar path. It keeps the C
   version's per-group `precinct_bits_left` check and error behavior.
5. **`idwt_horizontal_line_lf16_hf16` / `_lf32_hf16`**
   (`ASM_WASM_SIMD128/Idwt_wasm_simd128.c`). The C loop reads back the even
   output it just stored, which blocks auto-vectorization. The even outputs
   only depend on the inputs, so a block computes 4 evens twice (offset by
   one), derives 4 odds and interleaves them; the first and last outputs keep
   the C code. −7 to −10%.

Verification: `npm test` (14 tests, byte-for-byte vs native),
`test:browser`, `nix flake check` (wasm SIMD and wasm `--asm c` vs native,
cases a–g). Plus a fuzz run: 120 randomly corrupted codestreams (1080p 4:2:2
10-bit and 4:2:0 8-bit, 37 of them hitting decoder errors) decode identically
with the wasm SIMD kernels and with `--asm c`, including exit status.

Decode ms per frame (fresh process, AC power):

| Case | threads: 3 (1 worker) before | threads: 3 now | threads: 8 now | native C, 1 worker | native AVX2/512, 1 worker |
|------|-----------------------------|----------------|----------------|--------------------|---------------------------|
| 1080p 4:2:0 8-bit | 18.4 | **10.3–10.9** | 3.0 | 17.6 | 6.8 |
| 1080p 4:2:2 10-bit | 24.3 | **14.5–15.2** | 4.4 | 26.0 | 10.0 |
| 720p 4:4:4 12-bit | – | 17.5–18.6 | 4.8 | – | – |
| 2160p 4:2:2 10-bit | 74.9 | 49.1 | 14.9 | 75.7 | 29.0 |

**Target reached for 1080p 4:2:0 8-bit and 4:2:2 10-bit** (about 12% headroom
for 4:2:2 10-bit). The single-thread wasm decoder is now 1.7× faster than
native C. It is about 1.5× slower than native AVX2.

Remaining profile (1080p 4:2:2 10-bit, one worker):

| Part | Share |
|------|-------|
| `unpack_data_wasm_simd128` | 29% |
| `svt_jpeg_xs_decode_slice` (GCLI/VLC decoding inlined) | 17% |
| `transform_precinct` (inlined: output scaling/NLT, buffer handling) | 11% |
| IDWT horizontal (SIMD) | 13% |
| JS copy-out of the frame (`memmove`) | 5% |
| `idwt_vertical_line_c` | 4% |
| `dequant_wasm_simd128` | 3% |
| `vlc_reader_refill` | 2.4% |

### Step 3c: windowed unpack and output scaling (2026-11-13)

Both bit-exact, in the fork, uncommitted:

1. **`unpack_data_wasm_simd128`: one window for several groups.** The kernel
   loads a 16-nibble window and decodes as many consecutive groups from it as
   fit. Groups at or below `gtli` take no nibbles, so they come for free. The
   window's 4 bitmasks go into one `i32x4`. Each group's 4 outputs are built
   with vector shift/and/or, truncated to 16 bits with a byte shuffle and
   written with one 64-bit store. Error handling (per-group
   `precinct_bits_left` check, failing group zeroed, reader position) is
   unchanged. Groups that don't fit a window (corrupt streams) and the end of
   the buffer take the per-group path. About 4.5 → 3.5 ms/frame for this
   function (1080p 4:2:2 10-bit, profiled).
2. **`linear_output_scaling_{8,16}bit_line_wasm_simd128`**
   (`ASM_WASM_SIMD128/NltDec_wasm_simd128.c`), the inverse NLT for
   `Tnlt == 0`. C does the rounding shift in 64 bits; the kernel uses the
   overflow-free 32-bit form `(v >> dz) + (((v & (2^dz - 1)) + round) >> dz)`,
   clamps with `i32x4.min/max` and narrows with saturation (exact after the
   clamp). Parameters that valid streams don't produce (`dzeta` outside 0..30,
   `m < 0`, `m` above the output type) go to C, which truncates. It had been
   inlined into `transform_precinct` (11% of the profile) and is now 3.9%.
   The whole-frame variants `linear_output_scaling_{8,16}bit_wasm_simd128`
   (used only on the colour-transform path, `Cpih != 0`) loop the line
   kernel over the rows. **They are not covered by tests**: the SVT encoder
   never writes `Cpih != 0`, so we have no such streams.

Verification: `npm test`, `test:browser`, `nix flake check`, and a fuzz run of
160 corrupted codestreams (44 hitting decoder errors) with identical output
and exit status for wasm SIMD and wasm `--asm c`.

Decode ms per frame (fresh process, AC power):

| Case | threads | before (3b) | now |
|------|---------|-------------|-----|
| 1080p 4:2:0 8-bit | 3 (1 worker) | 9.8–10.9 | **8.8–10.1** |
| | 8 | 2.8 | 2.5 |
| 1080p 4:2:2 10-bit | 3 (1 worker) | 14.6–15.1 | **11.9–13.7** |
| | 8 | 4.5 | 3.5 |
| 720p 4:4:4 12-bit | 3 (1 worker) | 17.8–19.0 | 16.5–17.6 |
| 2160p 4:2:2 10-bit | 3 (1 worker) | 50.1 | 40.1 |
| | 8 | 15.2 | 13.4 |

1080p 4:2:2 10-bit on one worker now has about 20% headroom on the 60 fps
budget and is close to native AVX2 (10.0 ms).

Remaining profile (1080p 4:2:2 10-bit, one worker, 12.8 ms profiled):
`unpack_data_wasm_simd128` 27%, `svt_jpeg_xs_decode_slice` (GCLI/VLC
decoding) 21%, IDWT horizontal 13%, `idwt_vertical_line_c` 4.4%, JS copy-out
4.3%, output scaling 3.9%, dequant 3.9%, VLC refill 3%.

### Step 3d: GCLI decoding (2026-11-13)

A profile with `-O1` at link (so binaryen doesn't inline single-call-site
functions; only for attribution) put GCLI decoding at 15% of single-thread
time (about 2.1 ms/frame for 1080p 4:2:2 10-bit), almost all of it in
`unpack_pred_zero_gclis_no_significance`, plus 3% in `vlc_reader_refill`.
Each GCLI is a unary code, and the per-value `clz` → shift → `clz` chain is
serial. Changes in `Packing.c` (generic C, so native builds get them too;
uncommitted):

1. **`vlc_reader_get_values()`**: decodes a run of values with a 256-entry
   table over the next 8 register bits (`vlc_lut_values` / `_ends` /
   `_count`, generated). An entry gives the codes that end in those bits:
   values packed in 8 bytes, end positions in nibbles. `gtli` is added to all
   8 bytes with a carry-free SWAR add, and they are written with one (merged)
   8-byte store; bytes past the requested count are overwritten later by the
   caller. If no code ends in the 8 bits, or fewer than 8 bytes may be
   written, it calls `vlc_reader_get_next_value()`, which refills and reports
   errors. The table only consumes real bits (bits past the end of the data
   are zero and never end a code), so the result doesn't depend on refill
   timing. Used by both "prediction from zero" paths (with and without
   significance); vertical prediction still decodes per value.
2. **Inline register loads**: `vlc_reader_get_values()` tops up the register
   when it holds ≤ 32 bits and at least 64 bits of data are left (the same
   load as `vlc_reader_refill()`'s main branch, now `vlc_reader_load()`).

GCLI decoding dropped to about 1.3 ms/frame (−40%) after 1; 2 gave another
3–8% overall.

Verification: `npm test` (against the dev shell's native apps, which predate
the change), `test:browser`, `nix flake check`. These kernels are in generic C,
so comparing wasm SIMD with wasm `--asm c` doesn't test them. Instead,
`JxsCodec` from the build before this step and from the new one decoded 900
corrupted codestreams (1080p 4:2:2 10-bit, 4:2:0 8-bit, and 720p 4:4:4 12-bit
with sign coding and vertical prediction; 319 decoder errors) with identical
output or error code. The 210-stream SIMD-vs-C fuzz run also passes.

Decode ms per frame (fresh process, AC power):

| Case | threads | before (3c) | now |
|------|---------|-------------|-----|
| 1080p 4:2:0 8-bit | 3 (1 worker) | 9.0 | 7.9–8.8 |
| | 8 | 2.5 | 2.5 |
| 1080p 4:2:2 10-bit | 3 (1 worker) | 12.4 | **11.2–11.7** |
| | 8 | 3.7 | 3.4 |
| 720p 4:4:4 12-bit | 3 (1 worker) | 17.2 | 16.1 |
| 2160p 4:2:2 10-bit | 3 (1 worker) | 40.6 | 36.3 |
| | 8 | 13.2 | 12.1 |

Remaining profile (1080p 4:2:2 10-bit, one worker, `-O1` attribution
build): `unpack_data_wasm_simd128` 27%, GCLI decoding 10%, IDWT horizontal
14%, output scaling 5%, `idwt_vertical_line_c` 4.3%, JS copy-out 4.3%,
dequant 3.3%, VLC refill 2.5% (before the inline loads), precinct/slice
bookkeeping about 4%.

### Next steps (decoder)

1. Commit the kernels and the `Packing.c` changes. The `Packing.c` changes help
   every target (the indirect `svt_log2_32` call is also in the native C
   path); `FORCE_INLINE`/`NOINLINE` and the clz builtin are candidates for
   upstream.
2. Further single-thread headroom, roughly in order of payoff/effort:
   - GCLI decoding with vertical prediction still decodes per value (the
     table approach applies there too, with the `delta_m` mapping per value);
   - `unpack_data`: the remaining cost is mostly per-group control flow; a
     prefix sum over the group sizes could compute several groups' window
     offsets at once;
   - avoid the JS copy-out (decode into a caller-provided buffer or hand out
     a view), about 4%;
   - `idwt_vertical_line*` (check whether clang vectorized it).
3. Check the decoder's init/final stage loops and the encoder's stage loops for
   the Liftoff problem.
