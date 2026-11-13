#!/usr/bin/env bash
# Bit-exactness check of the wasm apps against the native reference apps.
# Encodes synthetic frames with the native SVT apps (SIMD and --asm c) and the
# wasm build (under node), decodes with native and wasm, and compares outputs.
# Exits non-zero on any mismatch.
#
# Usage: scripts/compare-apps.sh <native-bin-dir> <wasm-bin-dir> <work-dir>
#   <native-bin-dir>  contains SvtJpegxsEncApp / SvtJpegxsDecApp
#   <wasm-bin-dir>    contains SvtJpegxsEncApp.js / SvtJpegxsDecApp.js (+ .wasm)
set -euo pipefail
NATIVE=$(realpath "$1")
WASM=$(realpath "$2")
WORK=$3
mkdir -p "$WORK"
cd "$WORK"

gen() { # gen <file> <w> <h> <format> <depth> <frames>
  python3 -I - "$@" <<'EOF'
import sys, struct, random
out, w, h, fmt, depth, n = sys.argv[1], *map(int, sys.argv[2:4]), sys.argv[4], int(sys.argv[5]), int(sys.argv[6])
cw, ch = {"yuv420": (w//2, h//2), "yuv422": (w//2, h), "yuv444": (w, h)}[fmt]
mx = (1 << depth) - 1
rnd = random.Random(1234)
with open(out, "wb") as f:
    for fr in range(n):
        for (pw, ph) in ((w, h), (cw, ch), (cw, ch)):
            vals = []
            for y in range(ph):
                for x in range(pw):
                    v = ((x * 7 + y * 3 + fr * 11) % 256) / 255.0
                    if (x // 32 + y // 32) % 2: v = 1.0 - v
                    v = v * mx + rnd.randint(-mx // 16, mx // 16)
                    vals.append(min(mx, max(0, int(v))))
            if depth > 8:
                f.write(struct.pack("<%dH" % len(vals), *vals))
            else:
                f.write(bytes(vals))
EOF
}

native() { "$NATIVE/$1" "${@:2}"; }
wasm() { node "$WASM/$1.js" "${@:2}"; }

failures=0
check() { # check <a> <b> <label>
  if cmp -s "$1" "$2"; then
    echo "   ok:       $3"
  else
    echo "   MISMATCH: $3"
    failures=$((failures + 1))
  fi
}

run_case() { # run_case <name> <w> <h> <fmt> <depth> <bpp> [extra enc args]
  local name=$1 w=$2 h=$3 fmt=$4 depth=$5 bpp=$6; shift 6
  echo "== $name: ${w}x${h} $fmt ${depth}bit bpp=$bpp $*"
  gen "$name.yuv" "$w" "$h" "$fmt" "$depth" 3
  local enc=(-w "$w" -h "$h" --colour-format "$fmt" --input-depth "$depth" --bpp "$bpp" -n 3 --no-progress 1 -v 0 "$@")
  native SvtJpegxsEncApp -i "$name.yuv" -b "$name.native.jxs" "${enc[@]}" >/dev/null
  native SvtJpegxsEncApp -i "$name.yuv" -b "$name.native-c.jxs" --asm c "${enc[@]}" >/dev/null
  wasm SvtJpegxsEncApp -i "$name.yuv" -b "$name.wasm.jxs" "${enc[@]}" >/dev/null
  native SvtJpegxsDecApp -i "$name.native.jxs" -o "$name.native.dec.yuv" -v 0 >/dev/null
  wasm SvtJpegxsDecApp -i "$name.native.jxs" -o "$name.wasm.dec.yuv" -v 0 >/dev/null
  check "$name.native.jxs" "$name.native-c.jxs" "enc: native C == native SIMD"
  check "$name.native.jxs" "$name.wasm.jxs" "enc: wasm == native"
  check "$name.native.dec.yuv" "$name.wasm.dec.yuv" "dec: wasm == native"
}

run_case a 1920 1080 yuv420 8 3
run_case b 1280 720 yuv422 10 4
run_case c 640 480 yuv444 12 6 --coding-signs 2 --coding-vpred 1
run_case d 1000 600 yuv422 10 2.5 --rc 3 --decomp_v 1 --decomp_h 3
run_case e 1000 600 yuv422 10 3 --lp 8

if [ "$failures" -ne 0 ]; then
  echo "$failures comparison(s) failed"
  exit 1
fi
echo "all comparisons passed"
