{
  lib,
  stdenvNoCC,
  callPackage,
  emscripten,
  cmake,
  ninja,
  src,
  # Same as the jpegxs-web package (JXS_WASM_SIMD); consumers of the static
  # library then also need -msimd128.
  simd ? true,
}:

# SVT-JPEG-XS built with emscripten: portable C code paths only
# (ENABLE_X86_ASM=OFF) auto-vectorized for wasm SIMD, pthreads, static
# library + node CLI apps.
stdenvNoCC.mkDerivation {
  pname = "svt-jpegxs-wasm";
  version = "0.10.0";

  inherit src;

  nativeBuildInputs = [
    emscripten
    cmake
    ninja
  ];

  preConfigure = callPackage ./emscripten-env.nix { };

  configurePhase = ''
    runHook preConfigure
    emcmake cmake -S . -B build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX=$out \
      -DCMAKE_OUTPUT_DIRECTORY=$PWD/build/bin \
      -DENABLE_X86_ASM=OFF \
      -DBUILD_SHARED_LIBS=OFF \
      -DBUILD_APPS=ON \
      -DBUILD_TESTING=OFF \
      ${lib.optionalString simd ''-DCMAKE_C_FLAGS=-msimd128 -DCMAKE_EXE_LINKER_FLAGS=-msimd128''}
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
