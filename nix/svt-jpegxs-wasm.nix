{
  lib,
  stdenvNoCC,
  emscripten,
  cmake,
  ninja,
  src,
}:

# SVT-JPEG-XS built with emscripten: portable C code paths only
# (ENABLE_X86_ASM=OFF), pthreads, static library + node CLI apps.
stdenvNoCC.mkDerivation {
  pname = "svt-jpegxs-wasm";
  version = "0.10.0";

  inherit src;

  nativeBuildInputs = [
    emscripten
    cmake
    ninja
  ];

  # emscripten's cache in the nix store is read-only; start from a writable
  # copy of it (missing pthread variants of system libs get built here).
  # nixpkgs pairs emscripten with a newer binaryen than it expects; silence the
  # version check so -Werror builds don't fail on it.
  preConfigure = ''
    export HOME=$TMPDIR
    export EM_CACHE=$TMPDIR/emscripten-cache
    cp -r ${emscripten}/share/emscripten/cache $EM_CACHE
    chmod -R u+w $EM_CACHE
    export EMCC_CFLAGS="-Wno-version-check"
  '';

  configurePhase = ''
    runHook preConfigure
    emcmake cmake -S . -B build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX=$out \
      -DCMAKE_OUTPUT_DIRECTORY=$PWD/build/bin \
      -DENABLE_X86_ASM=OFF \
      -DBUILD_SHARED_LIBS=OFF \
      -DBUILD_APPS=ON \
      -DBUILD_TESTING=OFF
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    ninja -C build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    ninja -C build install
    runHook postInstall
  '';

  meta = {
    description = "Scalable Video Technology for JPEG XS compiled to WebAssembly";
    license = lib.licenses.bsd2Patent;
    platforms = lib.platforms.all;
  };
}
