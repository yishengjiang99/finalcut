# syntax=docker/dockerfile:1.7

FROM emscripten/emsdk:3.1.64 AS build

ARG FFMPEG_REF=n6.1.1
ENV PREFIX=/opt/ffmpeg-wasm

# Keep toolchain minimal (yasm/nasm not needed once asm is disabled, but harmless)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates pkg-config make \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# ---- Fetch FFmpeg ----
RUN git clone https://github.com/FFmpeg/FFmpeg.git FFmpeg \
 && cd FFmpeg \
 && git checkout "${FFMPEG_REF}"

WORKDIR /src/FFmpeg

# ---- Configure + build FFmpeg libs for WASM (size-optimized) ----
# Key size tactics:
# - --disable-everything then re-enable only what wrapper needs
# - disable all asm/x86
# - disable programs/devices/network/filters/bsfs/hwaccels/postproc
# - disable iconv (often saves several MB)
# - build static only
# - strip symbols at link (emcc --closure + strip in link stage below)
#
# Add/extend demuxers/decoders later if you want mp3/ogg/etc.
ENV CFLAGS="-O3 -DNDEBUG -ffunction-sections -fdata-sections"
ENV CXXFLAGS="-O3 -DNDEBUG -ffunction-sections -fdata-sections"
ENV LDFLAGS="-O3 -Wl,--gc-sections"

RUN emconfigure ./configure \
    --prefix="${PREFIX}" \
    --enable-cross-compile \
    --target-os=none \
    --arch=generic \
    --cc=emcc \
    --cxx=em++ \
    --ar=emar \
    --ranlib=emranlib \
    \
    --disable-doc \
    --disable-debug \
    --disable-runtime-cpudetect \
    --disable-autodetect \
    \
    --disable-programs \
    --disable-ffplay \
    --disable-ffprobe \
    --disable-ffmpeg \
    \
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
    # minimal for your wrapper smoke test:
    --enable-demuxer=wav \
    --enable-decoder=pcm_s16le,pcm_s16be,pcm_u8,pcm_f32le \
    \
 && emmake make -j"$(nproc)" \
 && emmake make install

# ---- Copy wrapper ----
WORKDIR /src
COPY package*.json /src/


COPY . /src/
COPY wrapper.c .

# ---- Link final wasm module (size-optimized) ----
# Size tactics here:
# - -Oz for smaller JS+WASM
# - LTO (flto) + gc-sections already in env
# - --closure 1 minifies JS glue (no npm)
# - EXPORT_NAME makes module name stable
# - ASSERTIONS=0 for size

RUN emcc wrapper.c \
    -I${PREFIX}/include \
    -L${PREFIX}/lib \
    -lavformat -lavcodec -lavutil -lswresample \
    -o ffmpeg.js \
    \
    -Oz \
    -flto \
    -sWASM=1 \
    -sMODULARIZE=1 \
    -sEXPORT_ES6=1 \
    -sEXPORT_NAME="FFmpegWasm" \
    -sENVIRONMENT=web,worker \
    -sALLOW_MEMORY_GROWTH=1 \
    -sFILESYSTEM=1 \
    -sASSERTIONS=0 \
    -sERROR_ON_UNDEFINED_SYMBOLS=1 \
    \
    -sEXPORTED_FUNCTIONS='["_wav_to_pcm16le_fs","_wasm_malloc","_wasm_free"]' \
    -sEXPORTED_RUNTIME_METHODS='["ccall","cwrap","FS"]' \
    \
    --closure 1

# ---- Artifact stage ----
FROM scratch AS artifact
COPY --from=build /src/ffmpeg.js /ffmpeg.js
COPY --from=build /src/ffmpeg.wasm /ffmpeg.wasm