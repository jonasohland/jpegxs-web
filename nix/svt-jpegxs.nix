{
  lib,
  stdenv,
  cmake,
  ninja,
  nasm,
  src,
}:

stdenv.mkDerivation {
  pname = "svt-jpegxs";
  version = "0.10.0";

  inherit src;

  nativeBuildInputs = [
    cmake
    ninja
    nasm
  ];

  cmakeFlags = [
    (lib.cmakeBool "BUILD_SHARED_LIBS" true)
    (lib.cmakeBool "BUILD_APPS" true)
    (lib.cmakeBool "BUILD_TESTING" false)
    (lib.cmakeBool "ENABLE_NASM" true)
  ];

  meta = {
    description = "Scalable Video Technology for JPEG XS (native reference build)";
    license = lib.licenses.bsd2Patent;
    platforms = [ "x86_64-linux" ];
    mainProgram = "SvtJpegxsDecApp";
  };
}
