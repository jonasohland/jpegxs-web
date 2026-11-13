{
  description = "JPEG XS decoder for the browser (SVT-JPEG-XS compiled to WebAssembly)";

  inputs = {
    # Include git submodules (third_party/SVT-JPEG-XS) in the flake source.
    self.submodules = true;

    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    jxs-cuda = {
      url = "git+ssh://git@bitbucket.org/riedelcommunications/jxs-cuda.git";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      jxs-cuda,
    }:
    let
      # SVT-JPEG-XS' native build requires x86 NASM; jxs-cuda is x86_64-linux only.
      systems = [ "x86_64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      overlays.default = final: prev: {
        svt-jpegxs = final.callPackage ./nix/svt-jpegxs.nix { src = ./third_party/SVT-JPEG-XS; };
        svt-jpegxs-wasm = final.callPackage ./nix/svt-jpegxs-wasm.nix { src = ./third_party/SVT-JPEG-XS; };
      };

      packages = forAllSystems (
        pkgs:
        let
          svt-jpegxs = pkgs.callPackage ./nix/svt-jpegxs.nix { src = ./third_party/SVT-JPEG-XS; };
        in
        {
          # Native reference build of the upstream encoder/decoder (CLI + shared lib).
          inherit svt-jpegxs;
          # WebAssembly build (C paths, pthreads): static lib + node CLI apps.
          svt-jpegxs-wasm = pkgs.callPackage ./nix/svt-jpegxs-wasm.nix { src = ./third_party/SVT-JPEG-XS; };
          # CUDA encoder/decoder, re-exported from its own flake.
          jxs-cuda = jxs-cuda.packages.${pkgs.system}.jxs-cuda;
          default = svt-jpegxs;
        }
      );

      devShells = forAllSystems (
        pkgs:
        let
          wasmTools = with pkgs; [
            emscripten
            cmake
            ninja
            pkg-config
            nodejs
            binaryen
            wabt
            python3
          ];
          # Writable emscripten cache; the one in the nix store is read-only.
          # nixpkgs pairs emscripten with a newer binaryen than it expects; the
          # resulting version-check warning breaks -Werror builds.
          shellHook = ''
            export EM_CACHE="$PWD/.emscripten_cache"
            export EMCC_CFLAGS="-Wno-version-check"
          '';
        in
        {
          # WebAssembly development + native SVT reference tools.
          default = pkgs.mkShell {
            packages = wasmTools ++ [ self.packages.${pkgs.system}.svt-jpegxs ];
            inherit shellHook;
          };

          # Same as default, plus the CUDA encoder/decoder (pulls in the CUDA toolkit).
          cuda = pkgs.mkShell {
            packages = wasmTools ++ [
              self.packages.${pkgs.system}.svt-jpegxs
              self.packages.${pkgs.system}.jxs-cuda
            ];
            inherit shellHook;
          };
        }
      );

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
