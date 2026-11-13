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
set(JXS_PTHREAD_POOL_SIZE "Module['jxsThreadPoolSize']??8" CACHE STRING
    "JS expression for the number of pre-spawned pthread workers")

# Library only; keep upstream's binaries inside our build tree.
set(BUILD_APPS OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(ENABLE_X86_ASM OFF CACHE BOOL "" FORCE)
set(CMAKE_OUTPUT_DIRECTORY "${PROJECT_BINARY_DIR}/svt" CACHE PATH "" FORCE)
add_subdirectory(third_party/SVT-JPEG-XS EXCLUDE_FROM_ALL)

add_executable(jxs csrc/jxs.c)
target_include_directories(jxs PRIVATE third_party/SVT-JPEG-XS/Source/API)
target_link_libraries(jxs PRIVATE SvtJpegxsLib)
target_compile_options(jxs PRIVATE -pthread -Wall -Wextra -Werror)
set_target_properties(jxs PROPERTIES
    SUFFIX ".mjs"
    RUNTIME_OUTPUT_DIRECTORY "${JXS_OUTPUT_DIR}")

target_link_options(jxs PRIVATE
    -pthread
    # The codec's pipeline threads are created synchronously during
    # encoder/decoder init and waited on right away, so they must come from a
    # pre-spawned pool (a new Worker can't start while we block).
    "-sPTHREAD_POOL_SIZE=${JXS_PTHREAD_POOL_SIZE}"
    -sPTHREAD_POOL_SIZE_STRICT=2
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sEXPORT_NAME=createJxsModule
    -sENVIRONMENT=web,worker,node
    -sFILESYSTEM=0
    -sALLOW_MEMORY_GROWTH=1
    -sMAXIMUM_MEMORY=4GB
    -sSTACK_SIZE=1MB
    -sDEFAULT_PTHREAD_STACK_SIZE=1MB
    -Wno-pthreads-mem-growth
    "-sEXPORTED_FUNCTIONS=_malloc,_free"
    "-sEXPORTED_RUNTIME_METHODS=wasmMemory"
    --no-entry)
