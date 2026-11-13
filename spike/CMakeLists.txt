# Phase 0 spike: build SVT-JPEG-XS (C paths only) with emscripten, bypassing
# the upstream CMake. Throwaway; replaced by proper fork support in Phase 1.
cmake_minimum_required(VERSION 3.20)
project(svt-jpegxs-wasm-spike C)

set(CMAKE_C_STANDARD 99)
set(SVT ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/SVT-JPEG-XS)
set(LIB ${SVT}/Source/Lib)

file(GLOB lib_sources
  ${LIB}/Common/Codec/*.c
  ${LIB}/Common/Codec/Threads/*.c
  ${LIB}/Decoder/Codec/*.c
  ${LIB}/Encoder/Codec/*.c)

# rtcd files include the SIMD kernel headers (prototypes only).
set(lib_includes
  ${SVT}/Source/API
  ${LIB}/Common/Codec
  ${LIB}/Common/ASM_SSE2
  ${LIB}/Common/ASM_AVX2
  ${LIB}/Decoder/Codec
  ${LIB}/Decoder/ASM_SSE4_1
  ${LIB}/Decoder/ASM_AVX2
  ${LIB}/Decoder/ASM_AVX512
  ${LIB}/Encoder/Codec
  ${LIB}/Encoder/ASM_SSE2
  ${LIB}/Encoder/ASM_SSE4_1
  ${LIB}/Encoder/ASM_AVX2
  ${LIB}/Encoder/ASM_AVX512)

add_compile_options(-pthread -Wall)
add_link_options(-pthread -sALLOW_MEMORY_GROWTH=1 -sNODERAWFS=1
                 -sEXIT_RUNTIME=1 -sPTHREAD_POOL_SIZE=16 -sSTACK_SIZE=1MB)

add_library(svtjxs STATIC ${lib_sources})
target_include_directories(svtjxs PUBLIC ${lib_includes})

function(svt_app name)
  add_executable(${name} ${ARGN})
  target_include_directories(${name} PRIVATE ${SVT}/Source/API ${SVT}/Source/App/Common)
  target_link_libraries(${name} svtjxs m)
endfunction()

file(GLOB app_common ${SVT}/Source/App/Common/*.c)
file(GLOB dec_app ${SVT}/Source/App/DecApp/*.c)
file(GLOB enc_app ${SVT}/Source/App/EncApp/*.c)
svt_app(SvtJpegxsDecApp ${dec_app} ${app_common})
svt_app(SvtJpegxsEncApp ${enc_app} ${app_common})
svt_app(SvtJpegxsSampleDecoder ${SVT}/Source/App/SampleDecoder/main.c)
svt_app(SvtJpegxsSampleEncoder ${SVT}/Source/App/SampleEncoder/main.c)
