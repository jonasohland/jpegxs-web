cmake_minimum_required(VERSION 3.20)
project(jpegxs-web C)

# Builds the browser/node module jxs.mjs + jxs.wasm from the SVT-JPEG-XS
# submodule and the C shim in csrc/. Configure with emcmake:
#
#   emcmake cmake -S . -B build/lib -G Ninja -DCMAKE_BUILD_TYPE=Release
#   ninja -C build/lib

if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "jpegxs-web must be configured with emcmake")
endif()

set(JXS_OUTPUT_DIR "${PROJECT_SOURCE_DIR}/dist" CACHE PATH "Where jxs.mjs and jxs.wasm are written")
# OFF builds the single-threaded variant jxs-st.mjs + jxs-st.wasm for pages
# that are not cross-origin isolated (no SharedArrayBuffer): no pthreads, the
# decoder runs its stages inline, and the encoder is not available.
option(JXS_THREADS "Build with pthreads" ON)
if(JXS_THREADS)
    set(JXS_OUTPUT_NAME_DEFAULT jxs)
else()
    set(JXS_OUTPUT_NAME_DEFAULT jxs-st)
endif()
set(JXS_OUTPUT_NAME "${JXS_OUTPUT_NAME_DEFAULT}" CACHE STRING "Base name of the .mjs/.wasm outputs")
set(JXS_PTHREAD_POOL_SIZE "Module['jxsThreadPoolSize']??8" CACHE STRING
    "JS expression for the number of pre-spawned pthread workers")
# 128-bit wasm SIMD lets clang auto-vectorize the C kernels (bit-exact; about
# 30-40% faster encoding, 10-15% faster decoding). Supported by every current
# browser (Chrome 91, Firefox 89, Safari 16.4) and node >= 16.4.
option(JXS_WASM_SIMD "Compile with -msimd128" ON)
if(JXS_WASM_SIMD)
    # Before add_subdirectory so that the codec library gets it too.
    add_compile_options(-msimd128)
    add_link_options(-msimd128)
endif()

# Library only; keep upstream's binaries inside our build tree.
set(BUILD_APPS OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(ENABLE_X86_ASM OFF CACHE BOOL "" FORCE)
set(ENABLE_THREADS ${JXS_THREADS} CACHE BOOL "" FORCE)
set(CMAKE_OUTPUT_DIRECTORY "${PROJECT_BINARY_DIR}/svt" CACHE PATH "" FORCE)
add_subdirectory(third_party/SVT-JPEG-XS EXCLUDE_FROM_ALL)

add_executable(jxs csrc/jxs.c)
target_include_directories(jxs PRIVATE third_party/SVT-JPEG-XS/Source/API)
target_link_libraries(jxs PRIVATE SvtJpegxsLib)
target_compile_options(jxs PRIVATE -Wall -Wextra -Werror)
set_target_properties(jxs PROPERTIES
    OUTPUT_NAME "${JXS_OUTPUT_NAME}"
    SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${JXS_OUTPUT_DIR}")

if(JXS_THREADS)
    target_compile_options(jxs PRIVATE -pthread)
    target_link_options(jxs PRIVATE
        -pthread
        # The codec's pipeline threads are created synchronously during
        # encoder/decoder init and waited on right away, so they must come
        # from a pre-spawned pool (a new Worker can't start while we block).
        "-sPTHREAD_POOL_SIZE=${JXS_PTHREAD_POOL_SIZE}"
        -sPTHREAD_POOL_SIZE_STRICT=2
        -sDEFAULT_PTHREAD_STACK_SIZE=1MB
        -Wno-pthreads-mem-growth)
endif()

target_link_options(jxs PRIVATE
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sEXPORT_NAME=createJxsModule
    -sENVIRONMENT=web,worker,node
    -sFILESYSTEM=0
    -sALLOW_MEMORY_GROWTH=1
    -sMAXIMUM_MEMORY=4GB
    -sSTACK_SIZE=1MB
    "-sEXPORTED_FUNCTIONS=_malloc,_free"
    "-sEXPORTED_RUNTIME_METHODS=wasmMemory"
    --no-entry)
