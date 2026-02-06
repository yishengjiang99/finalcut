# syntax=docker/dockerfile:1.7

FROM emscripten/emsdk:3.1.64 AS build

ARG FFMPEG_REF=n6.1.1
ARG BUILD_MODE=dev
# BUILD_MODE=dev  -> fast iteration (no LTO, no closure)
# BUILD_MODE=release -> smaller wasm (LTO + closure)

ENV PREFIX=/opt/ffmpeg-wasm
ENV CCACHE_DIR=/ccache

# ---- deps (cached) ----
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates pkg-config make ccache \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# ---- FFmpeg source (cached by layer) ----
RUN git clone https://github.com/FFmpeg/FFmpeg.git FFmpeg \
 && cd FFmpeg \
 && git checkout "${FFMPEG_REF}"

WORKDIR /src/FFmpeg

# ---- ccache wiring for emcc/em++ ----
# We route compilation through ccache by setting CC/CXX to "ccache emcc" etc.
# This gives huge speedups on rebuilds (especially if only wrapper changes).
ENV CC="ccache emcc"
ENV CXX="ccache em++"
ENV AR="emar"
ENV RANLIB="emranlib"

# Common size+compile flags; dev keeps it fast, release adds LTO at link time.
ENV COMMON_CFLAGS="-O3 -DNDEBUG -ffunction-sections -fdata-sections"
ENV COMMON_LDFLAGS="-O3 -Wl,--gc-sections"

# ---- Configure + Build FFmpeg libs (expensive step; cached + ccache) ----
RUN --mount=type=cache,target=/ccache,sharing=locked \
    bash -lc '\
      export CFLAGS="${COMMON_CFLAGS}"; \
      export CXXFLAGS="${COMMON_CFLAGS}"; \
      export LDFLAGS="${COMMON_LDFLAGS}"; \
      emconfigure ./configure \
        --prefix="${PREFIX}" \
        --enable-cross-compile \
        --target-os=none \
        --arch=generic \
        --cc="${CC}" \
        --cxx="${CXX}" \
        --ar="${AR}" \
        --ranlib="${RANLIB}" \
        \
        --disable-doc \
        --disable-debug \
        --disable-runtime-cpudetect \
        --disable-autodetect \
        \
        --disable-programs \
        --disable-network \
        --disable-devices \
        --disable-indevs \
        --disable-outdevs \
        --disable-postproc \
        --disable-hwaccels \
        --disable-filters \
        --disable-bsfs \
        --disable-iconv \
        \
        --disable-asm \
        --disable-inline-asm \
        --disable-x86asm \
        \
        --enable-static \
        --disable-shared \
        \
        --disable-everything \
        --enable-avutil \
        --enable-avcodec \
        --enable-avformat \
        --enable-swresample \
        \
        --enable-protocol=file \
        \
        --enable-demuxer=wav,mp3,ogg,flac \
        --enable-decoder=pcm_s16le,pcm_s16be,pcm_u8,pcm_f32le,mp3,vorbis,opus,flac \
      && emmake make -j"$(nproc)" \
      && emmake make install \
      && ccache -s \
    '

# ---- Link stage (fast to iterate) ----
WORKDIR /src
COPY wrapper.c .

# Link flags differ for dev/release
RUN bash -lc '\
  if [ "${BUILD_MODE}" = "release" ]; then \
    export LINK_EXTRA="-flto -Oz --closure 1 -sASSERTIONS=0"; \
  else \
    export LINK_EXTRA="-O2 -sASSERTIONS=1"; \
  fi; \
  emcc wrapper.c \
    -I${PREFIX}/include \
    -L${PREFIX}/lib \
    -lavformat -lavcodec -lavutil -lswresample \
    -o ffmpeg.js \
    \
    -sWASM=1 \
    -sMODULARIZE=1 \
    -sEXPORT_ES6=1 \
    -sEXPORT_NAME="FFmpegWasm" \
    -sENVIRONMENT=web,worker \
    -sALLOW_MEMORY_GROWTH=1 \
    -sFILESYSTEM=1 \
    -sERROR_ON_UNDEFINED_SYMBOLS=1 \
    -sEXPORTED_FUNCTIONS='\''["_wav_to_pcm16le_fs","_wasm_malloc","_wasm_free"]'\'' \
    -sEXPORTED_RUNTIME_METHODS='\''["ccall","cwrap","FS"]'\'' \
    ${LINK_EXTRA} \
'

FROM scratch AS artifact
COPY --from=build /src/ffmpeg.js /ffmpeg.js
COPY --from=build /src/ffmpeg.wasm /ffmpeg.wasm