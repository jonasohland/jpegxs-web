{
  lib,
  stdenvNoCC,
  callPackage,
  emscripten,
  cmake,
  ninja,
  typescript,
  src,
}:

# The jpegxs-web npm package: dist/jxs.{mjs,wasm} (threaded) and
# dist/jxs-st.{mjs,wasm} (single-threaded), both from emcmake, plus the compiled
# TypeScript wrapper. $out is the package directory (package.json + dist/),
# usable with `npm install <store path>`.
stdenvNoCC.mkDerivation {
  pname = "jpegxs-web";
  version = (lib.importJSON (src + "/package.json")).version;

  inherit src;

  nativeBuildInputs = [
    emscripten
    cmake
    ninja
    typescript
  ];

  preConfigure = callPackage ./emscripten-env.nix { };

  configurePhase = ''
    runHook preConfigure
    emcmake cmake -S . -B build/lib -G Ninja -DCMAKE_BUILD_TYPE=Release
    emcmake cmake -S . -B build/lib-st -G Ninja -DCMAKE_BUILD_TYPE=Release -DJXS_THREADS=OFF
    runHook postConfigure
  '';

  # Same steps as `npm run build`.
  buildPhase = ''
    runHook preBuild
    ninja -C build/lib
    ninja -C build/lib-st
    tsc -p .
    cp src/jxs.d.mts src/jxs-st.d.mts dist/
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -r package.json dist $out/
    runHook postInstall
  '';

  meta = {
    description = "JPEG XS encoder and decoder for the browser and node (SVT-JPEG-XS in WebAssembly)";
    license = lib.licenses.bsd2Patent;
    platforms = lib.platforms.all;
  };
}
