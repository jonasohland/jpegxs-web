{
  lib,
  runCommand,
  nodejs,
  python3,
  svt-jpegxs,
  svt-jpegxs-wasm,
  jpegxs-web,
  root,
}:

{
  # The upstream apps built for wasm (run under node) produce the same
  # codestreams and decoded frames as the native reference apps.
  svt-jpegxs-wasm-apps =
    runCommand "svt-jpegxs-wasm-apps-check"
      {
        nativeBuildInputs = [
          nodejs
          python3
        ];
      }
      ''
        bash ${root + "/scripts/compare-apps.sh"} \
          ${svt-jpegxs}/bin ${svt-jpegxs-wasm}/bin $TMPDIR/work
        touch $out
      '';

  # `npm test` against the packaged dist/, with byte-for-byte comparisons
  # against the native apps enforced.
  jpegxs-web-test =
    runCommand "jpegxs-web-test"
      {
        nativeBuildInputs = [
          nodejs
          svt-jpegxs
        ];
        JXS_REQUIRE_NATIVE = "1";
      }
      ''
        mkdir pkg
        cp -r ${jpegxs-web}/. pkg/
        cp -r ${
          lib.fileset.toSource {
            root = root;
            fileset = root + "/test";
          }
        }/test pkg/test
        chmod -R u+w pkg
        cd pkg
        node --test "test/**/*.test.ts"
        touch $out
      '';
}
