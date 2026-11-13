{ emscripten }:

# Shell snippet for derivations that build with emscripten.
# - emscripten's cache in the nix store is read-only; start from a writable
#   copy of it (missing pthread variants of system libs get built there).
# - nixpkgs pairs emscripten with a newer binaryen than it expects; silence the
#   version check so -Werror builds don't fail on it.
''
  export HOME=$TMPDIR
  export EM_CACHE=$TMPDIR/emscripten-cache
  cp -r ${emscripten}/share/emscripten/cache $EM_CACHE
  chmod -R u+w $EM_CACHE
  export EMCC_CFLAGS="-Wno-version-check"
''
