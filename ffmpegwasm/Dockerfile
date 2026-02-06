# syntax=docker/dockerfile:1.7

FROM emscripten/emsdk:3.1.64 AS build

ARG FFMPEG_REF=n6.1.1
ARG BUILD_MODE=dev

ENV PREFIX=/opt/ffmpeg-wasm
ENV CCACHE_DIR=/ccache

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates pkg-config make ccache \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src

RUN git clone https://github.com/FFmpeg/FFmpeg.git FFmpeg \
 && cd FFmpeg \
 && git checkout "${FFMPEG_REF}"

WORKDIR /src/FFmpeg

ENV CC="ccache emcc"
ENV CXX="ccache em++"
ENV AR="emar"
ENV RANLIB="emranlib"

ENV COMMON_FLAGS="-O3 -DNDEBUG -ffunction-sections -fdata-sections"

RUN --mount=type=cache,target=/ccache,sharing=locked \
    bash -lc '\
      export CFLAGS="${COMMON_FLAGS}"; \
      export CXXFLAGS="${COMMON_FLAGS}"; \
      export LDFLAGS="-Wl,--gc-sections"; \
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
        --disable-network \
        --disable-devices \
        --disable-hwaccels \
        --disable-postproc \
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
        \
        --enable-avcodec \
        --enable-avformat \
        --enable-avutil \
        --enable-swresample \
        \
        --enable-protocol=file \
        \
        --enable-ffmpeg \
        \
        --enable-demuxer=wav,mp3,ogg,flac \
        --enable-muxer=wav,mp3,ogg \
        \
        --enable-decoder=pcm_s16le,pcm_s16be,pcm_u8,mp3,vorbis,opus,flac \
        --enable-encoder=pcm_s16le \
      && emmake make -j"$(nproc)" \
      && emmake make install \
    '

WORKDIR /src

RUN bash -lc '\
  if [ "${BUILD_MODE}" = "release" ]; then \
    export LINK="-flto -Oz --closure 1 -sASSERTIONS=0"; \
  else \
    export LINK="-O2 -sASSERTIONS=1"; \
  fi; \
  emcc /opt/ffmpeg-wasm/bin/ffmpeg \
    -o ffmpeg.js \
    \
    -sWASM=1 \
    -sMODULARIZE=1 \
    -sEXPORT_ES6=1 \
    -sEXPORT_NAME="FFmpegWasm" \
    -sENVIRONMENT=web,worker \
    -sALLOW_MEMORY_GROWTH=1 \
    -sFILESYSTEM=1 \
    \
    -sEXPORTED_FUNCTIONS='["_main"]' \
    -sEXPORTED_RUNTIME_METHODS='["ccall","cwrap","FS"]' \
    \
    ${LINK} \
'

FROM scratch AS artifact
COPY --from=build /src/ffmpeg.js /ffmpeg.js
COPY --from=build /src/ffmpeg.wasm /ffmpeg.wasm