---
keyword: filmcraft optimization
title: filmcraft optimization in the browser, with before and after numbers
description: A video on what we optimized in our filmcraft fork: WebAssembly SIMD frame conversion, decoding and hardware export, with before and after numbers.
date: 2026-10-16
publish: true
product: finalcap
tags: [webassembly, simd, rust, benchmark]
hero: card.jpg
heroAlt: Card listing three filmcraft results, frame conversion 72.3 to 59.2 ms on x86, 13.71 to 12.25 ms on Apple M4 Pro, and a 6 second export from 23.6 to 7.1 seconds
properNouns: [WebAssembly, SIMD, YUV, RGBA, Apple, M4, Pro, H]
---
This is the filmcraft optimization story in one 86 second video. [filmcraft](https://github.com/storytold/filmcraft) is an open source video editor written in Rust that also runs in the browser, and our [fork](https://github.com/yishengjiang99/filmcraft) of it runs live at [grepawk.com/filmcraft](https://grepawk.com/filmcraft/). The video covers what we sped up, how, and the measured before and after numbers, each with its source.

```video
src: filmcraft-optimization-results.mp4
poster: filmcraft-optimization-poster.jpg
title: filmcraft optimization results (1 minute 26 seconds)
caption: Screen recording of the fork's web build, then before and after cards for frame conversion, decoding, export and the software encoder.
duration: PT1M26S
```

The recording of the editor is the live web build, recorded in headless Chrome. The cards are drawn from the numbers below, nothing else.

## filmcraft optimization results at a glance

| what | before | after | where it was measured |
| --- | --- | --- | --- |
| 1080p 4:2:0 frame to RGBA, WebAssembly | 72.3 ms | 59.2 ms (about 18% faster) | x86 virtual machine, 8 vCPU |
| 1080p 4:2:0 frame to RGBA, WebAssembly | 13.71 ms | 12.25 ms (about 11% faster) | Apple M4 Pro, Node 22 |
| 540p software decode per sample | 4.9 ms | 3.9 ms | x86 virtual machine, headless Chromium |
| Export of a 6 second 1080p clip | 23.6 s | 7.1 s (3.3 times faster) | Apple M4 Pro, Chrome 155 |
| Export of a longer 12 second edited project | 168.2 s | 133.8 s (1.26 times faster) | Apple M4 Pro, Chrome 155 |
| Software H.264 encoder, 1080p frame, WebAssembly | 109 to 117 ms | 58 to 61 ms (1.9 times faster) | Node 22 |
| Software H.264 encoder, 1080p frame, native | 79.8 ms | 45.7 ms (1.75 times faster) | Apple M4 Pro |

## Faster frame conversion with WebAssembly SIMD

Every video frame is decoded as YUV and has to become RGBA before the screen can draw it. The fork builds the web version with WebAssembly SIMD (`simd128`) and adds a conversion kernel that handles 4 pixels per step. Upstream's web build does not use SIMD. On the x86 virtual machine the median 4:2:0 frame went from 72.3 to 59.2 ms, and on an Apple M4 Pro from 13.71 to 12.25 ms. A checksum of every output frame matches across builds, so the pixels are identical.

On the M4 Pro the SIMD flag alone changed nothing for upstream's code (13.71 ms against 13.77 ms), so the gain comes from the new kernel. More detail is in [the earlier benchmark post](https://grepawk.com/blog/filmcraft-wasm-simd-yuv-benchmark).

## Decoding and the threaded build

With the browser's software decoder on a 540p clip, the fork took 3.9 ms per sample against 4.9 ms for upstream, about 18% less. The threaded WebAssembly build is live too, and it loads in threaded mode on the site. We have not measured a speedup from it: on this clip it behaves like the single-threaded build. See [what the fork gains in WebAssembly](https://grepawk.com/blog/filmcraft-fork-webassembly-speedups) for the rest of that data.

## Faster export with the hardware encoder

The fork's export can now use the browser's hardware H.264 encoder through WebCodecs, and it streams the output to disk instead of holding it all in memory. In Chrome 155 on an Apple M4 Pro, a 6 second 1080p clip took 23.6 seconds to export with the built-in software encoder and 7.1 seconds with the hardware encoder, 3.3 times faster. The encode cost per 1080p frame went from 99 ms to 9 ms.

A longer 12 second project with two video tracks, three cuts, a dissolve, a color effect, a title and music went from 168.2 to 133.8 seconds, 1.26 times faster. Most of that project's time is compositing on the CPU, which the encoder does not touch.

## Faster software encoder with SIMD

The built-in software encoder stays as the fallback. Its hot loops now use portable 128-bit SIMD from the `wide` crate, and each one is bit-identical to the scalar code it replaces. For 1080p frames with the export's settings, the whole encoder went from 79.8 to 45.7 ms per frame natively on the M4 Pro (1.75 times) and from 109 to 117 ms down to 58 to 61 ms in WebAssembly under Node 22 (1.9 times). The output bytes are unchanged.

## What is next

Compositing on the GPU for export is in progress. There is no published benchmark for it yet, so the video makes no claim about it.

## Limits of these numbers

- The export numbers come from one Apple M4 Pro. The 6 second clip is the median of 3 measured runs after a warmup, and the longer project is 2 runs.
- The frame conversion and decode numbers come from the x86 virtual machine and from the M4 Pro under Node, not from a browser on real hardware.
- The software encoder numbers were measured under Node 22 and natively, not inside Chrome.
- The live site was deployed before the export changes. They are on the fork's main branch and not in the live build yet.
- Bundle size, startup time and 120 Hz displays were not tested.

The raw numbers are in the fork's notes: [frame conversion](https://github.com/yishengjiang99/filmcraft/blob/main/docs/benchmarks/fork-vs-upstream.md), [playback and decode](https://github.com/yishengjiang99/filmcraft/blob/main/docs/benchmarks/playback.md), [web export](https://github.com/yishengjiang99/filmcraft/blob/main/docs/benchmarks/web-export.md) and the [software encoder](https://github.com/yishengjiang99/filmcraft/blob/main/crates/h264enc/README.md). For more on running video tools in the browser, see [FinalCap](https://grepawk.com/).

## Video transcript

filmcraft is an open source video editor in Rust that runs in the browser. This video covers what we optimized in our fork, and the measured results. This is the fork's web build, live at grepawk.com/filmcraft. The work is in frame conversion, decoding and export.

First, frame conversion. WebAssembly SIMD and a four pixel kernel cut a 1080p frame from 72 to 59 milliseconds on x86, and from 13.7 to 12.25 on an Apple M4 Pro. Software decode of a 540p clip takes 3.9 milliseconds a sample instead of 4.9. The threaded build is live too, but we have not measured a speedup from it.

Then export. With the browser's hardware H.264 encoder, a six second 1080p clip exports in 7.1 seconds instead of 23.6. A longer edited project goes from 168 to 134 seconds. The software encoder, the fallback, uses portable SIMD too. A 1080p frame in WebAssembly takes 58 to 61 milliseconds instead of 109 to 117, with identical output bytes.

Next is GPU compositing. It is in progress, with no published benchmark yet. The live build predates the export changes, which are on the fork's main branch. Try it at grepawk.com/filmcraft.
