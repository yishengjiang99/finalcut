---
title: Making FFmpeg in the browser use every core
description: A short video and notes on the ffmpeg.wasm fork we are building for FinalCap, covering WebAssembly threads, SharedArrayBuffer, SIMD and the bugs we fixed.
date: 2026-10-12
publish: true
hero: explainer-poster.jpg
heroAlt: Title slide of the ffmpeg.wasm threads explainer video
product: finalcap
tags: [FinalCap, FFmpeg, WebAssembly, threads, SIMD]
properNouns: [FFmpeg, WebAssembly, SharedArrayBuffer, SIMD, Workers, Web]
---
FinalCap edits video inside the browser tab with FFmpeg compiled to WebAssembly, so your clip is not uploaded to be edited. The upstream ffmpeg.wasm project has stopped shipping releases, so we are building our own fork on FFmpeg 8. This post is a written version of a three minute explainer video about that work.

```video
src: ffmpeg-wasm-explainer-v2.mp4
poster: explainer-poster.jpg
captions: explainer.vtt
title: ffmpeg.wasm threads explainer
caption: The voice is synthesized and the slides are plain diagrams and charts.
```

The fork is not in the app yet. Everything below was measured on test builds, on one machine: an Apple M4 Pro with 14 cores, in Chromium, one run per number.

## Threads in the browser are Web Workers that share memory

JavaScript runs one thread per context. A WebAssembly thread is a Web Worker, and all the workers of one program share a single block of memory called a SharedArrayBuffer. That is what lets FFmpeg decode, filter and encode on several cores at once.

Browsers only allow a SharedArrayBuffer on a cross-origin isolated page. Where that is not available, the editor falls back to a single-threaded build of FFmpeg.

## The deadlock that only showed up on bigger machines

The old multithreaded build started 32 workers up front and ran FFmpeg on the program's main thread, which blocked until the job finished. In the browser, starting a new thread needs that same main thread to create the worker. So a job that needed a 33rd thread waited forever.

FFmpeg sizes its thread pools from the number of cores, so this hit machines with 8 or more cores and jobs with several inputs. The 4-core cloud test machines never reproduced it. A 14-core laptop did, on the first encode.

The fix is to run each FFmpeg job on its own thread. The main thread stays free and starts workers when they are needed. Joining three clips with a crossfade used to hang. It now takes about 3 seconds, against 12 to 14 seconds on the single-threaded build.

## The encoder now scales past four threads

FinalCap capped the H.264 encoder at four threads because more would hang or crash. One cause was a function in x264 that was declared with one signature and called through another. Native code tolerates that. WebAssembly stops the program. It only happened with about six or more encoder threads.

With that fixed and the current upstream x264, re-encoding 10 seconds of 1080p video took:

| Encoder threads | Time |
| --- | --- |
| 1 | 9.8 s |
| 4 | 3.9 s |
| 8 | 2.3 s |
| 14 | 1.6 s |

## Memory that grows when it is needed

The old multithreaded build reserved a fixed 1 GB of memory when it loaded, which Safari on iPhone refuses. The fork starts at 256 MB and grows on demand up to 4 GB. We measured no slowdown from that.

## Jobs that used to fail after a few runs

Our test runs 60 small jobs in a row in one worker. The old build failed within the first few. The cause was an audio filter in FFmpeg that read a buffer before writing to it. In a fresh native process that buffer is usually zero. In a reused WebAssembly heap it holds leftovers from the last job. With the buffer cleared, all 60 jobs pass in Chromium, WebKit and Firefox.

## What SIMD did and did not do

SIMD means one instruction works on several values at once. WebAssembly has a 128-bit version that current browsers support, and the compiler uses it for loops it can vectorize.

Most of the speed of native FFmpeg and x264 comes from hand-written assembly for x86 and ARM, which cannot run in WebAssembly. FFmpeg 8 has some WebAssembly SIMD code of its own, today only for HEVC decoding. Turning it on made 1080p HEVC decoding about 3 percent faster. So the gains in this work come from threads, not from SIMD.

## What is left

These are single runs on one machine. The WebKit tests ran on a desktop build, so Safari on real iPhones still needs testing before the fork replaces the current engine in FinalCap.

The fork and its build scripts are public at [github.com/yishengjiang99/ffmpeg.wasm](https://github.com/yishengjiang99/ffmpeg.wasm).

## Try it

FinalCap runs in the browser at [grepawk.com](https://grepawk.com/).
