# FinalCap iOS: on-device image, video and audio processing catalog

**Status:** v1 (catalog + proposed grouped tool schemas for the first grouped-tool build, called "build 11" below).
**Owner:** FinalCut iOS. **Readers:** iOS (executor), Backend (allowlist and schemas), Design (card copy, see [`NATIVE_EDIT_UX.md` §8a](NATIVE_EDIT_UX.md)).
**Related:** [`native-tools.md`](native-tools.md) (build 10 tool mapping), [`docs/api/CLIENT_TOOL_EXECUTION.md`](../api/CLIENT_TOOL_EXECUTION.md) (client-mode contract), [`docs/api/tools-schema.v1.json`](../api/tools-schema.v1.json), [`src/server/iosToolAllowlist.js`](../../src/server/iosToolAllowlist.js).

Everything here runs on the iPhone with Apple frameworks only (Core Image, Vision, AVFoundation, Accelerate). Nothing is uploaded.

## 0. Where the numbers come from

| Source | What | Marked as |
|---|---|---|
| **Simulator dump** ([`.github/workflows/dump-cifilters.yml`](../../.github/workflows/dump-cifilters.yml), program [`data/dump_cifilters.swift`](data/dump_cifilters.swift)) | Every `CIFilter.filterNames(inCategory: nil)` entry with display name, Apple description, categories, `CIAttributeFilterAvailable_iOS`, and per input: class, type, default, identity, min, max, sliderMin, sliderMax. Category membership for all `kCICategory*`. `AVAudioUnit*` parameter trees (min/max/default). Vision request class availability and `supportedRevisions` | plain values, or "(dump)" |
| [`data/cifilters-ios17.5.json`](data/cifilters-ios17.5.json), [`data/platform-ios17.5.json`](data/platform-ios17.5.json) | iOS **17.5** (21F79) simulator runtime, Xcode 16.4, `macos-15` runner. No GitHub image ships an iOS 17 runtime; the workflow downloads it with `xcodebuild -downloadPlatform iOS -buildVersion 17.5` | |
| [`data/cifilters-ios26.5.json`](data/cifilters-ios26.5.json), [`data/platform-ios26.5.json`](data/platform-ios26.5.json) | iOS **26.5** (23F77) simulator runtime, Xcode 26.6, `macos-26` runner (newest iOS on any GitHub image as of 2026-09-26) | |
| Apple documentation / WWDC | Facts the dump can't show (enum preset names, Vision quality levels, API min iOS for non-CI classes, pixel-order conventions) | "(Apple docs)" |
| Engineering estimate | Per-frame cost classes, intensity curves, video feasibility | "(estimate)" / "our choice" |

Why not measured cost: a first attempt timed every filter at 1920x1080 in the simulator. Every filter, including a plain copy, took 500 to 1900 ms because the CI simulator GPU is paravirtualized and readback dominates, so the numbers said nothing about an iPhone. The bench was removed. **Cost classes below are estimates** for an A15-class iPhone rendering one 1080p frame on the GPU: **cheap** (per-pixel math, well under 2 ms), **medium** (convolution or multi-pass, roughly 2 to 8 ms, grows with radius), **heavy** (ML, large kernels or many passes, can exceed a 33 ms frame budget). Validate on device with Instruments before promising real-time preview for anything medium or heavy.

The dump runs as a simulator process, not on a physical device. Filter lists, attributes and AU parameter ranges are the same OS frameworks, but anything Neural-Engine-backed (Vision, `CIPersonSegmentation`) was only checked for existence, not executed.

Regenerate: run the workflow (`gh workflow run dump-cifilters.yml`), download the `cifilters-ios17` / `cifilters-ios26` artifacts into `docs/ios/data/`, then `python3 docs/ios/data/render_catalog.py` to rewrite the generated tables in this file.

### 0.1 Video vs photo rule

- **Video** means the filter can run per frame inside `AVMutableVideoComposition(asset:applyingCIFiltersWithHandler:)` (the same chain that drives preview, thumbnails and export, see `native-tools.md` §1). Core Image has no temporal state: every filter sees one frame. Anything that needs history (stabilization, optical-flow interpolation, mask smoothing) is our own code around the handler.
- **Photo** means `CIImage(contentsOf:)` with orientation applied, rendered once on export.
- The Media column: **both** = single-image filter flagged `kCICategoryVideo`; **photo** = not flagged for video by Apple (still runs, but not meant for real-time); **needs X** = requires another image input (mask, depth, second clip) we'd have to produce; **overlay src** = generator with no input image (composite it over the frame); **2nd image** = compositing/blend mode; **multi-clip** = transition between two clips; **analysis** = reduction whose output is statistics, not a picture.
- Blurs and other neighbourhood filters sample outside the frame: apply `clampedToExtent()` first and crop back to the frame, or edges go dark/transparent.
- Parameters typed `Distance` or `Position` in the dump are pixels in the CI image's coordinate space (origin bottom-left). Apple's defaults assume a ~300 to 600 px image (e.g. `inputCenter` = (150,150)). The executor must: put centers at the frame centre (or at the model's `center_x`/`center_y` fraction, top-left origin like `crop_video`), and scale distances by `min(width, height) / 1080` so a value tuned for 1080p looks the same on a 4032x3024 photo and a 720p clip.

## 1. Summary

- **iOS 17.5: 237 Core Image filters. iOS 26.5: 247.** Of these, 229 (17.5) / 237 (26.5) are flagged `kCICategoryVideo`. The app's minimum is iOS 17, so everything proposed below uses only filters present in the 17.5 dump.
- Single image in, image out and video-flagged (excluding transitions, generators, gradients, compositing and reductions): **140 on 17.5, 143 on 26.5** (dump). The rest are generators, compositing ops, transitions, reductions, depth/camera-only or HDR plumbing.
- Vision (dump, availability only): person segmentation, person instance masks, foreground instance masks, faces, text, horizon, saliency, optical flow and registration are all present on 17.5. `VNCalculateImageAestheticsScoresRequest` appears only on 26.5.
- AVFoundation audio units (dump): `AVAudioUnitEQ` (11 filter types, gain −96…24 dB, bandwidth 0.05…5 octaves), `AVAudioUnitReverb`, `AVAudioUnitDelay` (0.1 ms…2 s), `AVAudioUnitDistortion`, `AVAudioUnitTimePitch` (pitch −2400…2400 cents, rate 1/32…32), `AVAudioUnitVarispeed` (rate 0.25…4). Ranges are identical on 17.5 and 26.5.

### 1.1 What changed between iOS 17.5 and 26.5 (dump diff)

<!-- BEGIN GENERATED:ci-diff -->
- **iOS 17.5:** 237 filters. **iOS 26.5:** 247 filters. None removed.
- Added after 17.5 (`CIAttributeFilterAvailable_iOS`; Core Image reports iOS 26 as "19"): `CIAreaAlphaWeightedHistogram` (18), `CIAreaAverageMaximumRed` (26), `CIAreaBoundsRed` (18), `CIBlurredRoundedRectangleGenerator` (26), `CIDistanceGradientFromRedMask` (18), `CIMaximumScaleTransform` (18), `CIRoundedQRCodeGenerator` (26), `CISignedDistanceGradientFromRedMask` (26), `CISystemToneMap` (26), `CIToneMapHeadroom` (18).
- Parameter changes 17.5 → 26.5: `CIColorCube.inputCubeDimension` max 64 → 128; `CIColorCubeWithColorSpace.inputCubeDimension` max 64 → 128; `CIColorCubesMixedWithMask.inputCubeDimension` max 64 → 128; `CIPerspectiveCorrection.inputCrop` min unset → false; `CIPerspectiveCorrection.inputCrop` max unset → true; `CIRoundedRectangleGenerator` gained `inputSmoothness`; `CIRoundedRectangleStrokeGenerator` gained `inputSmoothness`; `CIToneCurve` gained `inputExtrapolate`. Area/reduction `inputExtent` defaults changed from (0,0,640,80) to (0,0,0,0); always pass an explicit extent.
- Category counts (17.5→26.5): Blur 15→15, BuiltIn 237→247, ColorAdjustment 18→20, ColorEffect 33→33, CompositeOperation 30→30, DistortionEffect 18→18, FilterGenerator 0→0, Generator 18→20, Geometry 14→15, Gradient 5→7, Halftone 5→5, HighDynamicRange 175→183, Interlaced 77→79, NonSquarePixels 77→79, Reduction 13→16, Sharpen 2→2, StillImage 237→247, Stylize 38→38, Tile 17→17, Transition 11→11, VideoCompatible 229→237.
<!-- END GENERATED:ci-diff -->

## 2. Core Image by category (from the dump)

Each filter is listed once, under the first matching category in this order: Transition, Generator, Gradient, CompositeOperation, Reduction, ColorAdjustment, ColorEffect, Blur, Sharpen, Halftone, Tile, DistortionEffect, Geometry, Stylize. Parameter ranges, defaults and min iOS are from the iOS 26.5 dump (identical in 17.5 except the changes in §1.1). `[min…max]` = hard attribute bounds, `{a…b}` = Apple's slider range; our clamping rule is in §9.0. "What it does" is Apple's own `localizedDescription` (first sentence). **Cost and notes are estimates.** Min iOS "26" is how this doc writes Core Image's internal "19".

<!-- BEGIN GENERATED:ci-catalog -->
### Transitions (need two clips; single clip = fade via the existing CI chain) (11)

| Filter | Display name | What it does (Apple text, first sentence) | Parameters: `key`=default [min…max] {slider} | Media | Min iOS | Cost | Notes |
|---|---|---|---|---|---|---|---|
| `CIAccordionFoldTransition` | Accordion Fold Transition | Transitions from one image to another of a differing dimensions by unfolding | `inputTargetImage` (image); `inputBottomHeight`=0 [0…]; `inputNumberOfFolds`=3 [1…50] {1…10}; `inputFoldShadowAmount`=0.1 [0…1] {0…1}; `inputTime`=0 [0…1] {0…1} | multi-clip | 8 | cheap |  |
| `CIBarsSwipeTransition` | Bars Swipe Transition | Transitions from one image to another by swiping rectangular portions of the foreground image to disclose the target image | `inputTargetImage` (image); `inputAngle`=π {0…2π}; `inputWidth`=30 [2…] {2…300}; `inputBarOffset`=10 [1…] {1…100}; `inputTime`=0 [0…1] {0…1} | multi-clip | 6 | cheap |  |
| `CICopyMachineTransition` | Copy Machine | Transitions from one image to another by simulating the effect of a copy machine | `inputTargetImage` (image); `inputExtent`=(0,0,300,300); `inputColor`=rgba(0.6,1,0.8,1); `inputTime`=0 [0…1] {0…1}; `inputAngle`=0 [0…] {0…2π}; `inputWidth`=200 [0.1…] {0.1…500}; `inputOpacity`=1.3 [0…] {0…3} | multi-clip | 6 | medium |  |
| `CIDisintegrateWithMaskTransition` | Disintegrate With Mask | Transitions from one image to another using the shape defined by a mask | `inputTargetImage` (image); `inputMaskImage` (image); `inputTime`=0 [0…1] {0…1}; `inputShadowRadius`=8 [0…] {0…50}; `inputShadowDensity`=0.65 [0…1] {0…1}; `inputShadowOffset`=(0,-10) | multi-clip | 6 | medium |  |
| `CIDissolveTransition` | Dissolve | Uses a dissolve to transition from one image to another | `inputTargetImage` (image); `inputTime`=0 [0…1] {0…1} | multi-clip | 6 | cheap |  |
| `CIFlashTransition` | Flash | Transitions from one image to another by creating a flash | `inputTargetImage` (image); `inputCenter`=(150,150); `inputExtent`=(0,0,300,300); `inputColor`=rgba(1,0.8,0.6,1); `inputTime`=0 [0…1] {0…1}; `inputMaxStriationRadius`=2.58 [0…] {0…10}; `inputStriationStrength`=0.5 [0…] {0…3}; `inputStriationContrast`=1.375 [0…] {0…5}; `inputFadeThreshold`=0.85 [0…1] {0…1} | multi-clip | 6 | cheap |  |
| `CIModTransition` | Mod | Transitions from one image to another by revealing the target image through irregularly shaped holes | `inputTargetImage` (image); `inputCenter`=(150,150); `inputTime`=0 [0…1] {0…1}; `inputAngle`=2 {-2π…2π}; `inputRadius`=150 [1…] {1…200}; `inputCompression`=300 [1…] {100…800} | multi-clip | 6 | cheap |  |
| `CIPageCurlTransition` | Page Curl | Transitions from one image to another by simulating a curling page, revealing the new image as the page curls | `inputTargetImage` (image); `inputBacksideImage` (image); `inputShadingImage` (image); `inputExtent`=(0,0,300,300); `inputTime`=0 [0…1] {0…1}; `inputAngle`=0 {-π…π}; `inputRadius`=100 [0.01…] {0.01…400} | multi-clip | 9 | medium |  |
| `CIPageCurlWithShadowTransition` | Page Curl With Shadow | Transitions from one image to another by simulating a curling page, revealing the new image as the page curls | `inputTargetImage` (image); `inputBacksideImage` (image); `inputExtent`=(0,0,0,0); `inputTime`=0 [0…1] {0…1}; `inputAngle`=0 {-π…π}; `inputRadius`=100 [0.01…] {0.01…400}; `inputShadowSize`=0.5 [0…1] {0…1}; `inputShadowAmount`=0.7 [0…1] {0…1}; `inputShadowExtent`=(0,0,0,0) | multi-clip | 9 | medium |  |
| `CIRippleTransition` | Ripple | Transitions from one image to another by creating a circular wave that expands from the center point, revealing the new image in the wake of the wave | `inputTargetImage` (image); `inputShadingImage` (image); `inputCenter`=(150,150); `inputExtent`=(0,0,300,300); `inputTime`=0 [0…1] {0…1}; `inputWidth`=100 [1…] {10…300}; `inputScale`=50 [-50…] {-50…50} | multi-clip | 9 | medium |  |
| `CISwipeTransition` | Swipe | Transitions from one image to another by simulating a swiping action | `inputTargetImage` (image); `inputExtent`=(0,0,300,300); `inputColor`=rgba(1,1,1,1); `inputTime`=0 [0…1] {0…1}; `inputAngle`=0 {-π…π}; `inputWidth`=300 [0.1…] {0.1…800}; `inputOpacity`=0 [0…] {0…1} | multi-clip | 6 | cheap |  |

### Generators (no input image: overlays, patterns, codes) (20)

| Filter | Display name | What it does (Apple text, first sentence) | Parameters: `key`=default [min…max] {slider} | Media | Min iOS | Cost | Notes |
|---|---|---|---|---|---|---|---|
| `CIAttributedTextImageGenerator` | Attributed Text Image Generator | Generate an image attributed string | `inputText` (NSAttributedString); `inputScaleFactor`=1 [0…] {1…4}; `inputPadding`=0 [0…200] {0…50} | overlay src | 11 | medium | text overlay; the app uses Core Text instead |
| `CIAztecCodeGenerator` | Aztec Code Generator | Generate an Aztec barcode image for message data | `inputMessage` (NSData); `inputCorrectionLevel`=23 [5…95] {5…95}; `inputLayers` [1…32] {1…32}; `inputCompactStyle` [false…true] {false…true} | overlay src (photo) | 8 | cheap |  |
| `CIBarcodeGenerator` | Barcode Generator | Generate a barcode image from a CIBarcodeDescriptor | `inputBarcodeDescriptor` (CIBarcodeDescriptor) | overlay src | 11 | cheap |  |
| `CIBlurredRectangleGenerator` | Blurred Rectangle Generator | Generates a blurred rectangle image with the specified extent, blur sigma, and color | `inputExtent`=(0,0,100,100); `inputSigma`=10 [0…] {0…100}; `inputColor`=rgba(1,1,1,1) | overlay src (photo) | 17 | cheap |  |
| `CIBlurredRoundedRectangleGenerator` | Blurred Rounded Rectangle Generator | Generates a blurred rounded rectangle image with the specified extent, corner radius, blur sigma, and color | `inputExtent`=(0,0,100,100); `inputRadius`=10 [0…] {0…100}; `inputSmoothness`=0 [0…1] {0…1}; `inputSigma`=10 [0…] {0…100}; `inputColor`=rgba(1,1,1,1) | overlay src (photo) | 26 (not in 17.5) | cheap |  |
| `CICheckerboardGenerator` | Checkerboard | Generates a pattern of squares of alternating colors | `inputCenter`=(150,150); `inputColor0`=rgba(1,1,1,1); `inputColor1`=rgba(0,0,0,1); `inputWidth`=80 {0…800}; `inputSharpness`=1 [0…1] {0…1} | overlay src | 5 | cheap |  |
| `CICode128BarcodeGenerator` | Code 128 Barcode Generator | Generate a Code 128 barcode image for message data | `inputMessage` (NSData); `inputQuietSpace`=10 [0…100] {0…20}; `inputBarcodeHeight`=32 [1…500] {1…50} | overlay src (photo) | 8 | cheap |  |
| `CIConstantColorGenerator` | Constant Color | Generates a solid color | `inputColor`=rgba(1,0,0,1) | overlay src | 5 | cheap |  |
| `CILenticularHaloGenerator` | Lenticular Halo | Simulates a halo that is generated by the diffraction associated with the spread of a lens | `inputCenter`=(150,150); `inputColor`=rgba(1,0.9,0.8,1); `inputHaloRadius`=70 [0…] {0…1000}; `inputHaloWidth`=87 [0…] {0…300}; `inputHaloOverlap`=0.77 [0…] {0…1}; `inputStriationStrength`=0.5 [0…] {0…3}; `inputStriationContrast`=1 [0…] {0…5}; `inputTime`=0 [0…1] {0…1} | overlay src | 9 | medium |  |
| `CIMeshGenerator` | Mesh Generator | Generates a mesh from an array of line segments | `inputWidth`=1.5 [0…] {1…10}; `inputColor`=rgba(1,1,1,1); `inputMesh` (NSArray) | overlay src | 12 | medium |  |
| `CIPDF417BarcodeGenerator` | PDF417 Barcode Generator | Generate a PDF417 barcode image for message data | `inputMessage` (NSData); `inputMinWidth` [56…583] {56…583}; `inputMaxWidth` [56…583] {56…583}; `inputMinHeight` [13…283] {13…283}; `inputMaxHeight` [13…283] {13…283}; `inputDataColumns` [1…30] {1…30}; `inputRows` [3…90] {3…90}; `inputPreferredAspectRatio` [0…9.223e+18] {0…9.223e+18}; `inputCompactionMode` [0…3] {0…3}; `inputCompactStyle` [false…true] {false…true}; `inputCorrectionLevel` [0…8] {0…8}; `inputAlwaysSpecifyCompaction` [false…true] {false…true} | overlay src | 9 | cheap |  |
| `CIQRCodeGenerator` | QR Code Generator | Generate a QR Code image for message data | `inputMessage` (NSData); `inputCorrectionLevel`=M (NSString) | overlay src (photo) | 7 | cheap |  |
| `CIRandomGenerator` | Random Generator | Generates an image of infinite extent whose pixel values are made up of four independent, uniformly-distributed random numbers in the 0 to 1 range | – | overlay src | 6 | cheap | static noise: offset it per frame for animated grain |
| `CIRoundedQRCodeGenerator` | Rounded QR Code Generator | Generate a QR Code image for message data | `inputMessage` (NSData); `inputCorrectionLevel`=M (NSString); `inputScale`=16 [8…64] {16…32}; `inputRoundedMarkers`=1 [0…2]; `inputRoundedData`=true [false…true]; `inputCenterSpaceSize`=0.25 [0…0.3333] {0.2…0.3333}; `inputColor0`=rgba(1,1,1,1); `inputColor1`=rgba(0,0,0,1) | overlay src (photo) | 26 (not in 17.5) | cheap |  |
| `CIRoundedRectangleGenerator` | Rounded Rectangle Generator | Generates a rounded rectangle image with the specified extent, corner radius, and color | `inputExtent`=(0,0,100,100); `inputRadius`=10 [0…] {0…100}; `inputSmoothness`=0 [0…1] {0…1}; `inputColor`=rgba(1,1,1,1) | overlay src (photo) | 13 | cheap |  |
| `CIRoundedRectangleStrokeGenerator` | Rounded Rectangle Stroke Generator | Generates a rounded rectangle stroke image with the specified extent, corner radius, stroke width, and color | `inputExtent`=(0,0,100,100); `inputRadius`=10 [0…] {0…100}; `inputSmoothness`=0 [0…1] {0…1}; `inputColor`=rgba(1,1,1,1); `inputWidth`=10 [0…] {0…100} | overlay src (photo) | 17 | cheap |  |
| `CIStarShineGenerator` | Star Shine | Generates a starburst pattern | `inputCenter`=(150,150); `inputColor`=rgba(1,0.8,0.6,1); `inputRadius`=50 [0…] {0…300}; `inputCrossScale`=15 [0…] {0…100}; `inputCrossAngle`=0.6 {-π…π}; `inputCrossOpacity`=-2 [-8…] {-8…0}; `inputCrossWidth`=2.5 [0…] {0.5…10}; `inputEpsilon`=-2 [-8…] {-8…0} | overlay src | 6 | cheap |  |
| `CIStripesGenerator` | Stripes | Generates a stripe pattern | `inputCenter`=(150,150); `inputColor0`=rgba(1,1,1,1); `inputColor1`=rgba(0,0,0,1); `inputWidth`=80 {0…800}; `inputSharpness`=1 [0…1] {0…1} | overlay src | 5 | cheap |  |
| `CISunbeamsGenerator` | Sunbeams | Generates a sun effect | `inputCenter`=(150,150); `inputColor`=rgba(1,0.5,0,1); `inputSunRadius`=40 [0…] {0…800}; `inputMaxStriationRadius`=2.58 [0…] {0…10}; `inputStriationStrength`=0.5 [0…] {0…3}; `inputStriationContrast`=1.375 [0…] {0…5}; `inputTime`=0 [0…1] {0…1} | overlay src | 9 | medium |  |
| `CITextImageGenerator` | Text Image Generator | Generate an image from a string and font information | `inputText` (NSString); `inputFontName`=HelveticaNeue (NSString); `inputFontSize`=12 [0…] {9…128}; `inputScaleFactor`=1 [0…] {1…4}; `inputPadding`=0 [0…200] {0…50} | overlay src | 11 | medium | text overlay; the app uses Core Text instead |

### Gradients (no input image except the mask-distance ones) (7)

| Filter | Display name | What it does (Apple text, first sentence) | Parameters: `key`=default [min…max] {slider} | Media | Min iOS | Cost | Notes |
|---|---|---|---|---|---|---|---|
| `CIDistanceGradientFromRedMask` | Distance Gradient From Red Mask | Produces an infinite image where the red channel contains the distance in pixels from each pixel to the mask | `inputMaximumDistance`=10 [0…1000] {1…100} | both | 18 (not in 17.5) | medium |  |
| `CIGaussianGradient` | Gaussian Gradient | Generates a gradient that varies from one color to another using a Gaussian distribution | `inputCenter`=(150,150); `inputColor0`=rgba(1,1,1,1); `inputColor1`=rgba(0,0,0,0); `inputRadius`=300 [0…] {0…800} | overlay src | 5 | cheap |  |
| `CIHueSaturationValueGradient` | Hue/Saturation/Value Gradient | Generates a color wheel that shows hues and saturations for a specified value | `inputValue`=1 [0…] {0…1}; `inputRadius`=300 [0…] {0…800}; `inputSoftness`=1 [0…] {0…1}; `inputDither`=1 [0…] {0…3}; `inputColorSpace`=CGColorSpace (NSObject) | overlay src | 10 | cheap |  |
| `CILinearGradient` | Linear Gradient | Generates a gradient that varies along a linear axis between two defined endpoints | `inputPoint0`=(0,0); `inputPoint1`=(200,200); `inputColor0`=rgba(1,1,1,1); `inputColor1`=rgba(0,0,0,1) | overlay src | 5 | cheap |  |
| `CIRadialGradient` | Radial Gradient | Generates a gradient that varies radially between two circles having the same center | `inputCenter`=(150,150); `inputRadius0`=5 [0…] {0…800}; `inputRadius1`=100 [0…] {0…800}; `inputColor0`=rgba(1,1,1,1); `inputColor1`=rgba(0,0,0,1) | overlay src | 5 | cheap |  |
| `CISignedDistanceGradientFromRedMask` | Signed Distance Gradient From Red Mask | Produces an infinite image where the red channel contains the distance in pixels from each pixel to the mask | `inputMaximumDistance`=10 [0…1000] {1…100} | both | 26 (not in 17.5) | medium |  |
| `CISmoothLinearGradient` | Smooth Linear Gradient | Generates a gradient that varies along a linear axis between two defined endpoints | `inputPoint0`=(0,0); `inputPoint1`=(200,200); `inputColor0`=rgba(1,1,1,1); `inputColor1`=rgba(0,0,0,1) | overlay src | 6 | cheap |  |

### Compositing and blend modes (need a second image) (30)

| Filter | Display name | What it does (Apple text, first sentence) | Parameters: `key`=default [min…max] {slider} | Media | Min iOS | Cost | Notes |
|---|---|---|---|---|---|---|---|
| `CIAdditionCompositing` | Addition | Adds color components to achieve a brightening effect | `inputBackgroundImage` (image) | 2nd image | 5 | cheap |  |
| `CIColorBlendMode` | Color Blend Mode | Uses the luminance values of the background with the hue and saturation values of the source image | `inputBackgroundImage` (image) | 2nd image | 5 | cheap |  |
| `CIColorBurnBlendMode` | Color Burn Blend Mode | Darkens the background image samples to reflect the source image samples | `inputBackgroundImage` (image) | 2nd image | 5 | cheap |  |
| `CIColorDodgeBlendMode` | Color Dodge Blend Mode | Brightens the background image samples to reflect the source image samples | `inputBackgroundImage` (image) | 2nd image | 5 | cheap |  |
| `CIDarkenBlendMode` | Darken Blend Mode | Creates composite image samples by choosing the darker samples (from either the source image or the background) | `inputBackgroundImage` (image) | 2nd image | 5 | cheap |  |
| `CIDifferenceBlendMode` | Difference Blend Mode | Subtracts either the source image sample color from the background image sample color, or the reverse, depending on which sample has the greater brightness value | `inputBackgroundImage` (image) | 2nd image | 5 | cheap |  |
| `CIDivideBlendMode` | Divide Blend Mode | Divides the background image sample color from the source image sample color | `inputBackgroundImage` (image) | 2nd image | 8 | cheap |  |
| `CIExclusionBlendMode` | Exclusion Blend Mode | Produces an effect similar to that produced by the “Difference Blend Mode” filter but with lower contrast | `inputBackgroundImage` (image) | 2nd image | 5 | cheap |  |
| `CIHardLightBlendMode` | Hard Light Blend Mode | Either multiplies or screens colors, depending on the source image sample color | `inputBackgroundImage` (image) | 2nd image | 5 | cheap |  |
| `CIHueBlendMode` | Hue Blend Mode | Uses the luminance and saturation values of the background with the hue of the source image | `inputBackgroundImage` (image) | 2nd image | 5 | cheap |  |
| `CILightenBlendMode` | Lighten Blend Mode | Creates composite image samples by choosing the lighter samples (either from the source image or the background) | `inputBackgroundImage` (image) | 2nd image | 5 | cheap |  |
| `CILinearBurnBlendMode` | Linear Burn Blend Mode | Inverts the unpremultiplied source and background image sample color, inverts the sum, and then blends the result with the background according to the PDF basic compositing formula | `inputBackgroundImage` (image) | 2nd image | 8 | cheap |  |
| `CILinearDodgeBlendMode` | Linear Dodge Blend Mode | Unpremultiplies the source and background image sample colors, adds them, and then blends the result with the background according to the PDF basic compositing formula | `inputBackgroundImage` (image) | 2nd image | 8 | cheap |  |
| `CILinearLightBlendMode` | Linear Light Blend Mode | A blend mode that is a combination of linear burn and linear dodge blend modes | `inputBackgroundImage` (image) | 2nd image | 15 | cheap |  |
| `CILuminosityBlendMode` | Luminosity Blend Mode | Uses the hue and saturation of the background with the luminance of the source image | `inputBackgroundImage` (image) | 2nd image | 5 | cheap |  |
| `CIMaximumCompositing` | Maximum | Computes the maximum value, by color component, of two input images and creates an output image using the maximum values | `inputBackgroundImage` (image) | 2nd image | 5 | cheap |  |
| `CIMinimumCompositing` | Minimum | Computes the minimum value, by color component, of two input images and creates an output image using the minimum values | `inputBackgroundImage` (image) | 2nd image | 5 | cheap |  |
| `CIMultiplyBlendMode` | Multiply Blend Mode | Multiplies the source image samples with the background image samples | `inputBackgroundImage` (image) | 2nd image | 5 | cheap |  |
| `CIMultiplyCompositing` | Multiply | Multiplies the color component of two input images and creates an output image using the multiplied values | `inputBackgroundImage` (image) | 2nd image | 5 | cheap |  |
| `CIOverlayBlendMode` | Overlay Blend Mode | Either multiplies or screens the source image samples with the background image samples, depending on the background color | `inputBackgroundImage` (image) | 2nd image | 5 | cheap |  |
| `CIPinLightBlendMode` | Pin Light Blend Mode | Unpremultiplies the source and background image sample color, combines them according to the relative difference, and then blends the result with the background according to the PDF basic compositing formula | `inputBackgroundImage` (image) | 2nd image | 8 | cheap |  |
| `CISaturationBlendMode` | Saturation Blend Mode | Uses the luminance and hue values of the background with the saturation of the source image | `inputBackgroundImage` (image) | 2nd image | 5 | cheap |  |
| `CIScreenBlendMode` | Screen Blend Mode | Multiplies the inverse of the source image samples with the inverse of the background image samples | `inputBackgroundImage` (image) | 2nd image | 5 | cheap |  |
| `CISoftLightBlendMode` | Soft Light Blend Mode | Either darkens or lightens colors, depending on the source image sample color | `inputBackgroundImage` (image) | 2nd image | 5 | cheap |  |
| `CISourceAtopCompositing` | Source Atop | Places the source image over the background image, then uses the luminance of the background image to determine what to show | `inputBackgroundImage` (image) | 2nd image | 5 | cheap |  |
| `CISourceInCompositing` | Source In | Uses the second image to define what to leave in the source image, effectively cropping the image | `inputBackgroundImage` (image) | 2nd image | 5 | cheap |  |
| `CISourceOutCompositing` | Source Out | Uses the second image to define what to take out of the first image | `inputBackgroundImage` (image) | 2nd image | 5 | cheap |  |
| `CISourceOverCompositing` | Source Over | Places the second image over the first | `inputBackgroundImage` (image) | 2nd image | 5 | cheap |  |
| `CISubtractBlendMode` | Subtract Blend Mode | Unpremultiplies the source and background image sample colors, subtracts the source from the background, and then blends the result with the background according to the PDF basic compositing formula | `inputBackgroundImage` (image) | 2nd image | 8 | cheap |  |
| `CIVividLightBlendMode` | Vivid Light Blend Mode | A blend mode that is a combination of color burn and color dodge blend modes | `inputBackgroundImage` (image) | 2nd image | 15 | cheap |  |

### Reductions (analysis: output is a 1xN or 1x1 statistics image, not a picture) (16)

| Filter | Display name | What it does (Apple text, first sentence) | Parameters: `key`=default [min…max] {slider} | Media | Min iOS | Cost | Notes |
|---|---|---|---|---|---|---|---|
| `CIAreaAlphaWeightedHistogram` | Area Alpha Weighted Histogram | Calculates alpha-weighted histograms of the unpremultiplied R, G, B channels for the specified area of an image | `inputExtent`=(0,0,0,0); `inputScale`=1 [0…] {0…1}; `inputCount`=64 [1…2048] {10…1000} | analysis | 18 (not in 17.5) | medium |  |
| `CIAreaAverage` | Area Average | Calculates the average color for the specified area in an image, returning the result in a pixel | `inputExtent`=(0,0,0,0) | analysis | 9 | cheap |  |
| `CIAreaAverageMaximumRed` | Area Average and Maximum Red | Calculates the average and maximum red component value for the specified area in an image | `inputExtent`=(0,0,0,0) | analysis | 26 (not in 17.5) | cheap |  |
| `CIAreaBoundsRed` | Area Bounds Red | Calculates the approximate bounding box of pixels within the specified area of an image where the red component values are non-zero | `inputExtent`=(0,0,0,0) | analysis | 18 (not in 17.5) | cheap |  |
| `CIAreaHistogram` | Area Histogram | Calculates histograms of the R, G, B, and A channels of the specified area of an image | `inputExtent`=(0,0,0,0); `inputScale`=1 [0…] {0…1}; `inputCount`=64 [1…2048] {10…1000} | analysis | 8 | medium |  |
| `CIAreaLogarithmicHistogram` | Area Logarithmic Histogram | Calculates histogram of the R, G, B, and A channels of the specified area of an image | `inputExtent`=(0,0,0,0); `inputScale`=1 [0…] {0…1}; `inputCount`=64 [1…2048] {10…1000}; `inputMinimumStop`=-10 {-12…-4}; `inputMaximumStop`=4 {0…8} | analysis | 16 | medium |  |
| `CIAreaMaximum` | Area Maximum | Calculates the maximum component values for the specified area in an image, returning the result in a pixel | `inputExtent`=(0,0,0,0) | analysis | 9 | cheap |  |
| `CIAreaMaximumAlpha` | Area Maximum Alpha | Finds and returns the pixel with the maximum alpha value | `inputExtent`=(0,0,0,0) | analysis | 9 | cheap |  |
| `CIAreaMinMax` | Area Min and Max | Calculates the per-component minimum and maximum value for the specified area in an image | `inputExtent`=(0,0,0,0) | analysis | 12 | cheap |  |
| `CIAreaMinMaxRed` | Area Min and Max Red | Calculates the minimum and maximum red component value for the specified area in an image | `inputExtent`=(0,0,0,0) | analysis | 11 | cheap |  |
| `CIAreaMinimum` | Area Minimum | Calculates the minimum component values for the specified area in an image, returning the result in a pixel | `inputExtent`=(0,0,0,0) | analysis | 9 | cheap |  |
| `CIAreaMinimumAlpha` | Area Minimum Alpha | Finds and returns the pixel with the minimum alpha value | `inputExtent`=(0,0,0,0) | analysis | 9 | cheap |  |
| `CIColumnAverage` | Column Average | Calculates the average color for each column of the specified area in an image, returning the result in a 1D image | `inputExtent`=(0,0,0,0) | analysis | 9 | cheap |  |
| `CIHistogramDisplayFilter` | Histogram Display | Generates a displayable histogram image from the output of the “Area Histogram” filter | `inputHeight`=100 [1…200] {1…100}; `inputHighLimit`=1 [0…1] {0…1}; `inputLowLimit`=0 [0…1] {0…1} | analysis | 8 | medium |  |
| `CIKMeans` | KMeans | Create a palette of the most common colors found in the image | `inputExtent`=(0,0,0,0); `inputMeans` (image); `inputCount`=8 [0…128]; `inputPasses`=5 [0…20]; `inputPerceptual`=false [false…true] | analysis | 13 | heavy | palette extraction (analysis) |
| `CIRowAverage` | Row Average | Calculates the average color for each row of the specified area in an image, returning the result in a 1D image | `inputExtent`=(0,0,0,0) | analysis | 9 | cheap |  |

### Color adjustment (20)

| Filter | Display name | What it does (Apple text, first sentence) | Parameters: `key`=default [min…max] {slider} | Media | Min iOS | Cost | Notes |
|---|---|---|---|---|---|---|---|
| `CIColorAbsoluteDifference` | Color Absolute Difference | Produces an image that is the absolute value of the color difference between two images | `inputImage2` (image) | needs image2 | 14 | cheap |  |
| `CIColorClamp` | Color Clamp | Clamp color to a certain range | `inputMinComponents`=(0,0,0,0); `inputMaxComponents`=(1,1,1,1) | both | 7 | cheap |  |
| `CIColorControls` | Color Controls | Adjusts saturation, brightness, and contrast values | `inputSaturation`=1 [0…] {0…2}; `inputBrightness`=0 [-1…] {-1…1}; `inputContrast`=1 [0…] {0.25…4} | both | 5 | cheap |  |
| `CIColorMatrix` | Color Matrix | Multiplies source color values and adds a bias factor to each color component | `inputRVector`=(1,0,0,0); `inputGVector`=(0,1,0,0); `inputBVector`=(0,0,1,0); `inputAVector`=(0,0,0,1); `inputBiasVector`=(0,0,0,0) | both | 5 | cheap | channel math (see Channel math) |
| `CIColorPolynomial` | Color Polynomial | Adjusts the color of an image with polynomials | `inputRedCoefficients`=(0,1,0,0); `inputGreenCoefficients`=(0,1,0,0); `inputBlueCoefficients`=(0,1,0,0); `inputAlphaCoefficients`=(0,1,0,0) | both | 7 | cheap | channel math |
| `CIColorThreshold` | Color Threshold | Produces a binarized image from an image and a threshold value | `inputThreshold`=0.5 {0…1} | both | 14 | cheap |  |
| `CIColorThresholdOtsu` | Color Threshold Otsu | Produces a binarized image from an image with finite extent | – | both | 14 | medium |  |
| `CIDepthToDisparity` | Depth To Disparity | Convert a depth data image to disparity data | – | both | 11 | cheap | depth data only |
| `CIDisparityToDepth` | Disparity To Depth | Convert a disparity data image to depth data | – | both | 11 | cheap | depth data only |
| `CIExposureAdjust` | Exposure Adjust | Adjusts the exposure setting for an image similar to the way you control exposure for a camera when you change the F-stop | `inputEV`=0 {-10…10} | both | 5 | cheap |  |
| `CIGammaAdjust` | Gamma Adjust | Adjusts midtone brightness | `inputPower`=1 {0.25…4} | both | 5 | cheap |  |
| `CIHueAdjust` | Hue Adjust | Changes the overall hue, or tint, of the source pixels | `inputAngle`=0 {-π…π} | both | 5 | cheap |  |
| `CILinearToSRGBToneCurve` | Linear to sRGB Tone Curve | Converts an image in linear space to sRGB space | – | both | 7 | cheap |  |
| `CISRGBToneCurveToLinear` | sRGB Tone Curve to Linear | Converts an image in sRGB space to linear space | – | both | 7 | cheap |  |
| `CISystemToneMap` | System Tone Map | Apply a global tone curve to an image that reduces colors of the input image to a desired dynamic range consistent with other frameworks | `inputDisplayHeadroom`=1 [1…32] {1…8}; `inputPreferredDynamicRange` (NSString) | both | 26 (not in 17.5) | cheap | HDR tone map (system curve) |
| `CITemperatureAndTint` | Temperature and Tint | Adapt the reference white point for an image | `inputNeutral`=(6500,0); `inputTargetNeutral`=(6500,0) | both | 5 | cheap |  |
| `CIToneCurve` | Tone Curve | Adjusts tone response of the R, G, and B channels of an image | `inputPoint0`=(0,0); `inputPoint1`=(0.25,0.25); `inputPoint2`=(0.5,0.5); `inputPoint3`=(0.75,0.75); `inputPoint4`=(1,1); `inputExtrapolate`=false [false…true] | both | 5 | cheap |  |
| `CIToneMapHeadroom` | Tone Map Headroom | Apply a global tone curve to an image that reduces colors from a source headroom value to a target headroom value | `inputSourceHeadroom` [1…32] {1…8}; `inputTargetHeadroom`=1 [1…32] {1…8} | both | 18 (not in 17.5) | cheap | HDR to SDR headroom mapping |
| `CIVibrance` | Vibrance | Adjusts the saturation of an image while keeping pleasing skin tones | `inputAmount`=0 [-1…1] {-1…1} | both | 5 | cheap |  |
| `CIWhitePointAdjust` | White Point Adjust | Adjusts the reference white point for an image and maps all colors in the source using the new reference | `inputColor`=rgba(1,1,1,1) | both | 5 | cheap |  |

### Color effects (33)

| Filter | Display name | What it does (Apple text, first sentence) | Parameters: `key`=default [min…max] {slider} | Media | Min iOS | Cost | Notes |
|---|---|---|---|---|---|---|---|
| `CIColorCrossPolynomial` | Color Cross Polynomial | Adjusts the color of an image with polynomials | `inputRedCoefficients`=(1,0,0,0,0,0,0,0,0,0); `inputGreenCoefficients`=(0,1,0,0,0,0,0,0,0,0); `inputBlueCoefficients`=(0,0,1,0,0,0,0,0,0,0) | both | 7 | cheap | channel math |
| `CIColorCube` | Color Cube | Uses a three-dimensional color table to transform the source image pixels | `inputCubeDimension`=2 [2…128]; `inputCubeData`=128 B data (NSData); `inputExtrapolate`=false [false…true] | both | 5 | cheap | LUT (see LUTs) |
| `CIColorCubeWithColorSpace` | Color Cube with ColorSpace | Uses a three-dimensional color table in a specified colorspace to transform the source image pixels | `inputCubeDimension`=2 [2…128]; `inputCubeData`=128 B data (NSData); `inputExtrapolate`; `inputColorSpace` (NSObject) | both | 7 | cheap | LUT (see LUTs) |
| `CIColorCubesMixedWithMask` | Color Cubes Mixed With Mask | Uses two three-dimensional color tables in a specified colorspace to transform the source image pixels | `inputMaskImage` (image); `inputCubeDimension`=2 [2…128]; `inputCube0Data`=128 B data (NSData); `inputCube1Data`=128 B data (NSData); `inputColorSpace` (NSObject); `inputExtrapolate`=false [false…true] | needs maskimage | 11 | cheap | two LUTs mixed by a mask (see LUTs) |
| `CIColorCurves` | Color Curves | Uses a three-channel one-dimensional color table to transform the source image pixels | `inputCurvesData`=36 B data (NSData); `inputCurvesDomain`=(0,1); `inputColorSpace` (NSObject) | both | 11 | cheap |  |
| `CIColorInvert` | Color Invert | Inverts the colors in an image | – | both | 5 | cheap |  |
| `CIColorMap` | Color Map | Performs a nonlinear transformation of source color values using mapping values provided in a table | `inputGradientImage` (image) | needs gradientimage | 6 | cheap |  |
| `CIColorMonochrome` | Color Monochrome | Remaps colors so they fall within shades of a single color | `inputColor`=rgba(0.6,0.45,0.3,1); `inputIntensity`=1 [0…] {0…1} | both | 5 | cheap |  |
| `CIColorPosterize` | Color Posterize | Remaps red, green, and blue color components to the number of brightness values you specify for each color component | `inputLevels`=6 [1…] {2…30} | both | 6 | cheap |  |
| `CIConvertLabToRGB` | Convert Lab to RGB | Converts an image from La*b* color space to the Core Image RGB working space | `inputNormalize`=false [false…true] | both | 16 | cheap |  |
| `CIConvertRGBtoLab` | Convert RGB to Lab | Converts an image from the Core Image RGB working space to La*b* color space | `inputNormalize`=false [false…true] | both | 16 | cheap |  |
| `CIDither` | Dither | Apply dithering to an image | `inputIntensity`=0.1 [0…5] {0…1} | both | 12 | medium |  |
| `CIDocumentEnhancer` | Document Enhancer | Enhance a document image by removing unwanted shadows, whitening the background, and enhancing contrast | `inputAmount`=1 [0…10] {0…2} | photo | 13 | heavy | document scans; not flagged video |
| `CIFalseColor` | False Color | Maps luminance to a color ramp of two colors | `inputColor0`=rgba(0.3,0,0,1); `inputColor1`=rgba(1,0.9,0.8,1) | both | 5 | cheap |  |
| `CILabDeltaE` | Lab ∆E | Produces an image with the Lab ∆E difference values between two images | `inputImage2` (image) | needs image2 | 11 | medium |  |
| `CIMaskToAlpha` | Mask to Alpha | Converts a grayscale image to a white image that is masked by alpha | – | both | 6 | cheap |  |
| `CIMaximumComponent` | Maximum Component | Converts an image to grayscale using the maximum of the three color components | – | both | 6 | cheap |  |
| `CIMinimumComponent` | Minimum Component | Converts an image to grayscale using the minimum of the three color components | – | both | 6 | cheap |  |
| `CIPaletteCentroid` | Palette Centroid | Calculate the mean (x,y) image coordinates of a color palette | `inputPaletteImage` (image); `inputPerceptual`=false [false…true] | needs paletteimage | 13 | heavy |  |
| `CIPalettize` | Palettize | Paint an image from a color palette obtained using “CIKMeans“ | `inputPaletteImage` (image); `inputPerceptual`=false [false…true] | needs paletteimage | 13 | heavy | needs a palette image (e.g. from CIKMeans) |
| `CIPhotoEffectChrome` | Photo Effect Chrome | Apply a “Chrome” style effect to an image | `inputExtrapolate`=false [false…true] | both | 7 | cheap |  |
| `CIPhotoEffectFade` | Photo Effect Fade | Apply a “Fade” style effect to an image | `inputExtrapolate`=false [false…true] | both | 7 | cheap |  |
| `CIPhotoEffectInstant` | Photo Effect Instant | Apply an “Instant” style effect to an image | `inputExtrapolate`=false [false…true] | both | 7 | cheap |  |
| `CIPhotoEffectMono` | Photo Effect Mono | Apply a “Mono” style effect to an image | `inputExtrapolate`=false [false…true] | both | 7 | cheap |  |
| `CIPhotoEffectNoir` | Photo Effect Noir | Apply a “Noir” style effect to an image | `inputExtrapolate`=false [false…true] | both | 7 | cheap |  |
| `CIPhotoEffectProcess` | Photo Effect Process | Apply a “Process” style effect to an image | `inputExtrapolate`=false [false…true] | both | 7 | cheap |  |
| `CIPhotoEffectTonal` | Photo Effect Tonal | Apply a “Tonal” style effect to an image | `inputExtrapolate`=false [false…true] | both | 7 | cheap |  |
| `CIPhotoEffectTransfer` | Photo Effect Transfer | Apply a “Transfer” style effect to an image | `inputExtrapolate`=false [false…true] | both | 7 | cheap |  |
| `CISepiaTone` | Sepia Tone | Maps the colors of an image to various shades of brown | `inputIntensity`=1 [0…] {0…1} | both | 5 | cheap |  |
| `CIThermal` | Thermal | Apply a “Thermal” style effect to an image | – | both | 10 | cheap |  |
| `CIVignette` | Vignette | Applies a vignette shading to the corners of an image | `inputIntensity`=0 [-1…1] {-1…1}; `inputRadius`=1 [0…2] {0…2} | both | 5 | cheap |  |
| `CIVignetteEffect` | Vignette Effect | Applies a vignette shading to the corners of an image | `inputCenter`=(150,150); `inputRadius`=150 [0…] {0…2000}; `inputIntensity`=1 [-1…1] {-1…1}; `inputFalloff`=0.5 [0…1] {0…1} | both | 7 | cheap | radius in px: scale with frame |
| `CIXRay` | X-Ray | Apply an “XRay” style effect to an image | – | both | 10 | cheap |  |

### Blur (15)

| Filter | Display name | What it does (Apple text, first sentence) | Parameters: `key`=default [min…max] {slider} | Media | Min iOS | Cost | Notes |
|---|---|---|---|---|---|---|---|
| `CIBokehBlur` | Bokeh Blur | Smooths an image using a disc-shaped convolution kernel | `inputRadius`=20 [0…500] {0…100}; `inputRingAmount`=0 [0…1] {0…1}; `inputRingSize`=0.1 [0…0.2] {0…0.2}; `inputSoftness`=1 [0…10] {0.25…0.4} | both | 11 | heavy | clampedToExtent() then crop; cost grows with radius |
| `CIBoxBlur` | Box Blur | Smooths or sharpens an image using a box-shaped convolution kernel | `inputRadius`=10 [1…] {1…100} | both | 9 | medium | clampedToExtent() then crop; cost grows with radius |
| `CIDepthBlurEffect` | Depth Blur Effect | Applies a variable radius disc blur to an image where areas in the background are softened more than those in the foreground | `inputDisparityImage` (image); `inputMatteImage` (image); `inputHairImage` (image); `inputGlassesImage` (image); `inputGainMap` (image); `inputAperture`=0 [0…22] {1…22}; `inputLeftEyePositions`=(-1,-1); `inputRightEyePositions`=(-1,-1); `inputChinPositions`=(-1,-1); `inputNosePositions`=(-1,-1); `inputFocusRect`; `inputLumaNoiseScale`=0 [0…0.1] {0…0.1}; `inputScaleFactor`=1 {0…1}; `inputCalibrationData` (AVCameraCalibrationData); `inputAuxDataMetadata` (CGImageMetadataRef); `inputShape` (NSString) | needs disparityimage, matteimage, hairimage, glassesimage, gainmap | 11 | heavy | needs depth/disparity (Portrait photos only) |
| `CIDiscBlur` | Disc Blur | Smooths an image using a disc-shaped convolution kernel | `inputRadius`=8 [0…] {0…100} | both | 9 | medium | clampedToExtent() then crop; cost grows with radius |
| `CIGaussianBlur` | Gaussian Blur | Spreads source pixels by an amount specified by a Gaussian distribution | `inputRadius`=10 [0…] {0…100} | both | 6 | medium | clampedToExtent() then crop; cost grows with radius |
| `CIMaskedVariableBlur` | Masked Variable Blur | Blurs an image according to the brightness levels in a mask image | `inputMask` (image); `inputRadius`=5 [0…] {0…10} | needs mask | 8 | heavy | blur amount from a mask (tilt-shift, background blur) |
| `CIMedianFilter` | Median | Computes the median value for a group of neighboring pixels and replaces each pixel value with the median | – | both | 9 | medium | clampedToExtent() then crop; cost grows with radius |
| `CIMorphologyGradient` | Morphology Gradient | Finds the edges of an image by returning the difference between the morphological minimum and maximum operations to the image | `inputRadius`=5 [0…] {0…50} | both | 11 | medium | dilate/erode; cost grows with radius |
| `CIMorphologyMaximum` | Morphology Maximum | Lightens areas of an image by applying a circular morphological maximum operation to the image | `inputRadius`=0 {0…50} | both | 11 | medium | dilate/erode; cost grows with radius |
| `CIMorphologyMinimum` | Morphology Minimum | Darkens areas of an image by applying a circular morphological maximum operation to the image | `inputRadius`=0 {0…50} | both | 11 | medium | dilate/erode; cost grows with radius |
| `CIMorphologyRectangleMaximum` | Morphology Rectangle Maximum | Lightens areas of an image by applying a rectangular morphological maximum operation to the image | `inputWidth`=5 [1…] {1…49}; `inputHeight`=5 [1…] {1…49} | both | 13 | medium | dilate/erode; cost grows with radius |
| `CIMorphologyRectangleMinimum` | Morphology Rectangle Minimum | Darkens areas of an image by applying a rectangular morphological maximum operation to the image | `inputWidth`=5 [1…] {1…49}; `inputHeight`=5 [1…] {1…49} | both | 13 | medium | dilate/erode; cost grows with radius |
| `CIMotionBlur` | Motion Blur | Blurs an image to simulate the effect of using a camera that moves a specified angle and distance while capturing the image | `inputRadius`=20 [0…] {0…100}; `inputAngle`=0 {-π…π} | both | 8.3 | medium | clampedToExtent() then crop; cost grows with radius |
| `CINoiseReduction` | Noise Reduction | Reduces noise using a threshold value to define what is considered noise | `inputNoiseLevel`=0.02 [0…] {0…0.1}; `inputSharpness`=0.4 [0…] {0…2} | both | 9 | medium | clampedToExtent() then crop; cost grows with radius |
| `CIZoomBlur` | Zoom Blur | Simulates the effect of zooming the camera while capturing the image | `inputCenter`=(150,150); `inputAmount`=20 {-200…200} | both | 8.3 | medium | clampedToExtent() then crop; cost grows with radius |

### Sharpen (2)

| Filter | Display name | What it does (Apple text, first sentence) | Parameters: `key`=default [min…max] {slider} | Media | Min iOS | Cost | Notes |
|---|---|---|---|---|---|---|---|
| `CISharpenLuminance` | Sharpen Luminance | Increases image detail by sharpening | `inputSharpness`=0.4 {0…2}; `inputRadius`=1.69 {0…20} | both | 6 | medium | clampedToExtent() then crop; cost grows with radius |
| `CIUnsharpMask` | Unsharp Mask | Increases the contrast of the edges between pixels of different colors in an image | `inputRadius`=2.5 [0…] {0…100}; `inputIntensity`=0.5 [0…] {0…1} | both | 6 | medium | clampedToExtent() then crop; cost grows with radius |

### Halftone (5)

| Filter | Display name | What it does (Apple text, first sentence) | Parameters: `key`=default [min…max] {slider} | Media | Min iOS | Cost | Notes |
|---|---|---|---|---|---|---|---|
| `CICMYKHalftone` | CMYK Halftone | Creates a color, halftoned rendition of the source image, using cyan, magenta, yellow, and black inks over a white page | `inputCenter`=(150,150); `inputWidth`=6 [-2…] {2…100}; `inputAngle`=0 {-π…π}; `inputSharpness`=0.7 [0…] {0…1}; `inputGCR`=1 [0…] {0…1}; `inputUCR`=0.5 [0…] {0…1} | both | 9 | cheap |  |
| `CICircularScreen` | Circular Screen | Simulates a circular-shaped halftone screen | `inputCenter`=(150,150); `inputWidth`=6 [1…] {2…50}; `inputSharpness`=0.7 [0…1] {0…1} | both | 6 | cheap |  |
| `CIDotScreen` | Dot Screen | Simulates the dot patterns of a halftone screen | `inputCenter`=(150,150); `inputAngle`=0 {-π…π}; `inputWidth`=6 [1…] {2…50}; `inputSharpness`=0.7 [0…1] {0…1} | both | 6 | cheap |  |
| `CIHatchedScreen` | Hatched Screen | Simulates the hatched pattern of a halftone screen | `inputCenter`=(150,150); `inputAngle`=0 {-π…π}; `inputWidth`=6 [1…] {2…50}; `inputSharpness`=0.7 [0…1] {0…1} | both | 6 | cheap |  |
| `CILineScreen` | Line Screen | Simulates the line pattern of a halftone screen | `inputCenter`=(150,150); `inputAngle`=0 {-π…π}; `inputWidth`=6 [1…] {2…50}; `inputSharpness`=0.7 [0…1] {0…1} | both | 6 | cheap |  |

### Tile and kaleidoscope (17)

| Filter | Display name | What it does (Apple text, first sentence) | Parameters: `key`=default [min…max] {slider} | Media | Min iOS | Cost | Notes |
|---|---|---|---|---|---|---|---|
| `CIAffineClamp` | Affine Clamp | Performs an affine transformation on a source image and then clamps the pixels at the edge of the transformed image, extending them outwards | `inputTransform`=description (NSValue) | both | 6 | cheap |  |
| `CIAffineTile` | Affine Tile | Applies an affine transformation to an image and then tiles the transformed image | `inputTransform`=description (NSValue) | both | 6 | cheap |  |
| `CIClamp` | Clamp | Clamps an image so the pixels with the specified extent are left unchanged but those at the boundary of the extent are extended outwards | `inputExtent`=(0,0,0,0) | both | 10 | cheap |  |
| `CIEightfoldReflectedTile` | Eightfold Reflected Tile | Produces a tiled image from a source image by applying an 8-way reflected symmetry | `inputCenter`=(150,150); `inputAngle`=0 {-π…π}; `inputWidth`=100 [0…] {1…200} | both | 6 | cheap |  |
| `CIFourfoldReflectedTile` | Fourfold Reflected Tile | Produces a tiled image from a source image by applying a 4-way reflected symmetry | `inputCenter`=(150,150); `inputAngle`=0 {-π…π}; `inputWidth`=100 [0…] {1…200}; `inputAcuteAngle`=π/2 {-π…π} | both | 6 | cheap |  |
| `CIFourfoldRotatedTile` | Fourfold Rotated Tile | Produces a tiled image from a source image by rotating the source at increments of 90 degrees | `inputCenter`=(150,150); `inputAngle`=0 {-π…π}; `inputWidth`=100 [0…] {1…200} | both | 6 | cheap |  |
| `CIFourfoldTranslatedTile` | Fourfold Translated Tile | Produces a tiled image from a source image by applying 4 translation operations | `inputCenter`=(150,150); `inputAngle`=0 {-π…π}; `inputWidth`=100 [0…] {1…200}; `inputAcuteAngle`=π/2 {-π…π} | both | 6 | cheap |  |
| `CIGlideReflectedTile` | Glide Reflected Tile | Produces a tiled image from a source image by translating and smearing the image | `inputCenter`=(150,150); `inputAngle`=0 {-π…π}; `inputWidth`=100 [0…] {1…200} | both | 6 | cheap |  |
| `CIKaleidoscope` | Kaleidoscope | Produces a kaleidoscopic image from a source image by applying 12-way symmetry | `inputCount`=6 [1…] {1…64}; `inputCenter`=(150,150); `inputAngle`=0 {-π…π} | both | 9 | cheap |  |
| `CIOpTile` | Op Tile | Segments an image, applying any specified scaling and rotation, and then assembles the image again to give an op art appearance | `inputCenter`=(150,150); `inputScale`=2.8 [0…] {0.1…10}; `inputAngle`=0 {-π…π}; `inputWidth`=65 [0…] {1…1000} | both | 9 | cheap |  |
| `CIParallelogramTile` | Parallelogram Tile | Warps an image by reflecting it in a parallelogram, and then tiles the result | `inputCenter`=(150,150); `inputAngle`=0 {-π…π}; `inputAcuteAngle`=π/2 {-π…π}; `inputWidth`=100 [0…] {1…200} | both | 9 | cheap |  |
| `CIPerspectiveTile` | Perspective Tile | Applies a perspective transform to an image and then tiles the result | `inputTopLeft`=(118,484); `inputTopRight`=(646,507); `inputBottomRight`=(548,140); `inputBottomLeft`=(155,153) | both | 6 | cheap |  |
| `CISixfoldReflectedTile` | Sixfold Reflected Tile | Produces a tiled image from a source image by applying a 6-way reflected symmetry | `inputCenter`=(150,150); `inputAngle`=0 {-π…π}; `inputWidth`=100 [0…] {1…200} | both | 6 | cheap |  |
| `CISixfoldRotatedTile` | Sixfold Rotated Tile | Produces a tiled image from a source image by rotating the source at increments of 60 degrees | `inputCenter`=(150,150); `inputAngle`=0 {-π…π}; `inputWidth`=100 [0…] {1…200} | both | 6 | cheap |  |
| `CITriangleKaleidoscope` | Triangle Kaleidoscope | Maps a triangular portion of image to a triangular area and then generates a kaleidoscope effect | `inputPoint`=(150,150); `inputSize`=700 {0…1000}; `inputRotation`=5.924 {0…2π}; `inputDecay`=0.85 {0…1} | both | 6 | cheap |  |
| `CITriangleTile` | Triangle Tile | Maps a triangular portion of image to a triangular area and then tiles the result | `inputCenter`=(150,150); `inputAngle`=0 {-π…π}; `inputWidth`=100 [0…] {1…200} | both | 9 | cheap |  |
| `CITwelvefoldReflectedTile` | Twelvefold Reflected Tile | Produces a tiled image from a source image by applying a 12-way reflected symmetry | `inputCenter`=(150,150); `inputAngle`=0 {-π…π}; `inputWidth`=100 [0…] {1…200} | both | 6 | cheap |  |

### Distortion (18)

| Filter | Display name | What it does (Apple text, first sentence) | Parameters: `key`=default [min…max] {slider} | Media | Min iOS | Cost | Notes |
|---|---|---|---|---|---|---|---|
| `CIBumpDistortion` | Bump Distortion | Creates a concave or convex bump that originates at a specified point in the image | `inputCenter`=(150,150); `inputRadius`=300 [0…] {0…600}; `inputScale`=0.5 {-1…1} | both | 6 | cheap |  |
| `CIBumpDistortionLinear` | Bump Distortion Linear | Creates a bump that originates from a linear portion of the image | `inputCenter`=(150,150); `inputRadius`=300 [0…] {0…600}; `inputAngle`=0 {0…2π}; `inputScale`=0.5 [-1…] {0…1} | both | 6 | cheap |  |
| `CICameraCalibrationLensCorrection` | Lens Correction for AVC | Geometrically distorts an image by altering the magnification based on the radial distance from the optical center to the farthest radius | `inputAVCameraCalibrationData` (AVCameraCalibrationData); `inputUseInverseLookUpTable`=false | both | 12 | medium | needs AVCameraCalibrationData (capture-time only) |
| `CICircleSplashDistortion` | Circle Splash Distortion | Distorts the pixels starting at the circumference of a circle and emanating outward | `inputCenter`=(150,150); `inputRadius`=150 [0…] {0…1000} | both | 6 | cheap |  |
| `CICircularWrap` | Circular Wrap Distortion | Wraps an image around a transparent circle | `inputCenter`=(150,150); `inputRadius`=150 [0…] {0…600}; `inputAngle`=0 {-π…π} | both | 9 | cheap | output has transparent area |
| `CIDisplacementDistortion` | Displacement Distortion | Applies the grayscale values of the second image to the first image | `inputDisplacementImage` (image); `inputScale`=50 [0…] {0…200} | needs displacementimage | 9 | cheap |  |
| `CIDroste` | Droste | The Droste effect produces an infinite image by distorting an image into a spiral of the image within itself | `inputInsetPoint0`=(200,200); `inputInsetPoint1`=(400,400); `inputStrands`=1 [-10…10] {-2…2}; `inputPeriodicity`=1 [1…] {1…5}; `inputRotation`=0 {0…2π}; `inputZoom`=1 [0.01…] {0.01…5} | both | 9 | heavy | very expensive at 1080p |
| `CIGlassDistortion` | Glass Distortion | Distorts an image by applying a glass-like texture | `inputTexture` (image); `inputCenter`=(150,150); `inputScale`=200 [0…] {0.01…500} | needs texture | 8 | heavy |  |
| `CIGlassLozenge` | Glass Lozenge | Creates a lozenge-shaped lens and distorts the portion of the image over which the lens is placed | `inputPoint0`=(150,150); `inputPoint1`=(350,150); `inputRadius`=100 [0…] {0…1000}; `inputRefraction`=1.7 [0…] {0…5} | both | 9 | medium |  |
| `CIHoleDistortion` | Hole Distortion | Creates a circular area that pushes the image pixels outward, distorting those pixels closest to the circle the most | `inputCenter`=(150,150); `inputRadius`=150 [0.01…] {0.01…1000} | both | 6 | cheap | leaves transparent hole |
| `CILightTunnel` | Light Tunnel Distortion | Light tunnel distortion | `inputCenter`=(150,150); `inputRotation`=0 {0…π/2}; `inputRadius`=100 {1…500} | both | 6 | cheap |  |
| `CINinePartStretched` | Nine Part Stretched | Distorts an image by stretching an image based on two input breakpoints | `inputBreakpoint0`=(50,50); `inputBreakpoint1`=(150,150); `inputGrowAmount`=(100,100) | both | 10 | cheap |  |
| `CINinePartTiled` | Nine Part Tiled | Distorts an image by tiling an image based on two input breakpoints | `inputBreakpoint0`=(50,50); `inputBreakpoint1`=(150,150); `inputGrowAmount`=(100,100); `inputFlipYTiles`=true [false…true] | both | 10 | cheap |  |
| `CIPinchDistortion` | Pinch Distortion | Creates a rectangular-shaped area that pinches source pixels inward, distorting those pixels closest to the rectangle the most | `inputCenter`=(150,150); `inputRadius`=300 [0…] {0…1000}; `inputScale`=0.5 [0…] {0…2} | both | 6 | cheap |  |
| `CIStretchCrop` | Stretch Crop | Distorts an image by stretching and or cropping to fit a target size | `inputSize`=(1280,720); `inputCropAmount`=0.25 [0…1] {0…1}; `inputCenterStretchAmount`=0.25 [0…1] {0…1} | both | 9 | cheap |  |
| `CITorusLensDistortion` | Torus Lens Distortion | Creates a torus-shaped lens and distorts the portion of the image over which the lens is placed | `inputCenter`=(150,150); `inputRadius`=160 [0…] {0…500}; `inputWidth`=80 [0…] {0…200}; `inputRefraction`=1.7 [0…] {0…5} | both | 9 | medium |  |
| `CITwirlDistortion` | Twirl Distortion | Rotates pixels around a point to give a twirling effect | `inputCenter`=(150,150); `inputRadius`=300 [0…] {0…500}; `inputAngle`=π {-4π…4π} | both | 5 | cheap |  |
| `CIVortexDistortion` | Vortex Distortion | Rotates pixels around a point to simulate a vortex | `inputCenter`=(150,150); `inputRadius`=300 [0…] {0…800}; `inputAngle`=56.55 {-94.25…94.25} | both | 6 | cheap |  |

### Geometry (15)

| Filter | Display name | What it does (Apple text, first sentence) | Parameters: `key`=default [min…max] {slider} | Media | Min iOS | Cost | Notes |
|---|---|---|---|---|---|---|---|
| `CIAffineTransform` | Affine Transform | Applies an affine transformation to an image | `inputTransform`=description (NSValue) | both | 5 | cheap |  |
| `CIBicubicScaleTransform` | Bicubic Scale Transform | Produces a high-quality, scaled version of a source image | `inputScale`=1 [0…] {0.05…100}; `inputAspectRatio`=1 [0…] {0.5…2}; `inputB`=0 [0…1] {0…1}; `inputC`=0.75 [0…1] {0…1} | both | 11 | cheap |  |
| `CICrop` | Crop | Applies a crop to an image | `inputRectangle`=(-∞,-∞,∞,∞) | both | 5 | cheap |  |
| `CIEdgePreserveUpsampleFilter` | Edge Preserve Upsample Filter | Upsamples a small image to the size of the input image using the luminance of the input image as a guide to preserve detail | `inputSmallImage` (image); `inputSpatialSigma`=3 [0…5]; `inputLumaSigma`=0.15 [0…1] | needs smallimage | 10 | heavy |  |
| `CIGuidedFilter` | Guided Filter | Upsamples a small image to the size of the guide image using the content of the guide to preserve detail | `inputGuideImage` (image); `inputRadius`=1 {1…10}; `inputEpsilon`=0.0001 {1e-09…0.1} | needs guideimage | 12 | medium |  |
| `CIKeystoneCorrectionCombined` | Combined Keystone Correction | Apply keystone correction to an image with combined horizontal and vertical guides | `inputFocalLength`=28; `inputTopLeft`; `inputTopRight`; `inputBottomRight`; `inputBottomLeft` | both | 13 | cheap | needs corner/focal data |
| `CIKeystoneCorrectionHorizontal` | Horizontal Keystone Correction | Apply horizontal keystone correction to an image with guides | `inputFocalLength`=28; `inputTopLeft`; `inputTopRight`; `inputBottomRight`; `inputBottomLeft` | both | 13 | cheap | needs corner data |
| `CIKeystoneCorrectionVertical` | Vertical Keystone Correction | Apply vertical keystone correction to an image with guides | `inputFocalLength`=28; `inputTopLeft`; `inputTopRight`; `inputBottomRight`; `inputBottomLeft` | both | 13 | cheap | needs corner data |
| `CILanczosScaleTransform` | Lanczos Scale Transform | Produces a high-quality, scaled version of a source image | `inputScale`=1 [0…] {0.05…1.5}; `inputAspectRatio`=1 [0…] {0.5…2} | both | 6 | cheap |  |
| `CIMaximumScaleTransform` | Maximum Scale Transform | Produces a scaled version of a source image that uses the maximum of neighboring pixels instead of linear averaging | `inputScale`=1 [0…] {0.05…1.5}; `inputAspectRatio`=1 [0…] {0.5…2} | both | 18 (not in 17.5) | cheap |  |
| `CIPerspectiveCorrection` | Perspective Correction | Apply a perspective correction to an image | `inputTopLeft`=(118,484); `inputTopRight`=(646,507); `inputBottomRight`=(548,140); `inputBottomLeft`=(155,153); `inputCrop`=true [false…true] | both | 8 | cheap | needs 4 corner points (e.g. from VNDetectRectanglesRequest) |
| `CIPerspectiveRotate` | Perspective Rotate | Apply a homogenous rotation transform to an image | `inputFocalLength`=28 {15…100}; `inputPitch`=0 {-0.5236…0.5236}; `inputYaw`=0 {-0.5236…0.5236}; `inputRoll`=0 {-0.7854…0.7854} | both | 13 | cheap |  |
| `CIPerspectiveTransform` | Perspective Transform | Alters the geometry of an image to simulate the observer changing viewing position | `inputTopLeft`=(118,484); `inputTopRight`=(646,507); `inputBottomRight`=(548,140); `inputBottomLeft`=(155,153) | both | 6 | cheap |  |
| `CIPerspectiveTransformWithExtent` | Perspective Transform with Extent | Alters the geometry of an image to simulate the observer changing viewing position | `inputExtent`=(0,0,300,300); `inputTopLeft`=(118,484); `inputTopRight`=(646,507); `inputBottomRight`=(548,140); `inputBottomLeft`=(155,153) | both | 6 | cheap |  |
| `CIStraightenFilter` | Straighten | Rotates a source image by the specified angle in radians | `inputAngle`=0 {-π…π} | both | 5 | cheap | rotate + crop to fill (horizon fix) |

### Stylize (38)

| Filter | Display name | What it does (Apple text, first sentence) | Parameters: `key`=default [min…max] {slider} | Media | Min iOS | Cost | Notes |
|---|---|---|---|---|---|---|---|
| `CIBlendWithAlphaMask` | Blend With Alpha Mask | Uses values from a mask image to interpolate between an image and the background | `inputBackgroundImage` (image); `inputMaskImage` (image) | needs backgroundimage, maskimage | 7 | cheap |  |
| `CIBlendWithBlueMask` | Blend With Blue Mask | Uses values from a mask image to interpolate between an image and the background | `inputBackgroundImage` (image); `inputMaskImage` (image) | needs backgroundimage, maskimage | 11 | cheap |  |
| `CIBlendWithMask` | Blend With Mask | Uses values from a grayscale mask to interpolate between an image and the background | `inputBackgroundImage` (image); `inputMaskImage` (image) | needs backgroundimage, maskimage | 6 | cheap |  |
| `CIBlendWithRedMask` | Blend With Red Mask | Uses values from a mask image to interpolate between an image and the background | `inputBackgroundImage` (image); `inputMaskImage` (image) | needs backgroundimage, maskimage | 11 | cheap |  |
| `CIBloom` | Bloom | Softens edges and applies a pleasant glow to an image | `inputRadius`=10 [0…] {0…100}; `inputIntensity`=0.5 [0…] {0…1} | both | 6 | medium | clampedToExtent() then crop; cost grows with radius |
| `CICannyEdgeDetector` | Canny Edge Detector | Applies the Canny Edge Detection algorithm to an image | `inputGaussianSigma`=1.6 [0…] {0…5}; `inputPerceptual`=false [false…true]; `inputThresholdHigh`=0.05 [0…] {0…0.4}; `inputThresholdLow`=0.02 [0…] {0…0.2}; `inputHysteresisPasses`=1 [0…20] {0…5} | both | 17 | medium |  |
| `CIComicEffect` | Comic Effect | Simulates a comic book drawing by outlining edges and applying a color halftone effect | – | both | 9 | medium |  |
| `CIConvolution3X3` | 3 by 3 Convolution | Convolution with 3 by 3 matrix | `inputWeights`=(0,0,0,0,1,0,0,0,0); `inputBias`=0 | both | 7 | cheap | custom kernel weights |
| `CIConvolution5X5` | 5 by 5 Convolution | Convolution with 5 by 5 matrix | `inputWeights`=(0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0); `inputBias`=0 | both | 7 | cheap | custom kernel weights |
| `CIConvolution7X7` | 7 by 7 Convolution | Convolution with 7 by 7 matrix | `inputWeights`=(0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0); `inputBias`=0 | both | 9 | medium | custom kernel weights |
| `CIConvolution9Horizontal` | Horizontal 9 Convolution | Horizontal Convolution with 9 values | `inputWeights`=(0,0,0,0,1,0,0,0,0); `inputBias`=0 | both | 7 | medium | custom kernel weights |
| `CIConvolution9Vertical` | Vertical 9 Convolution | Vertical Convolution with 9 values | `inputWeights`=(0,0,0,0,1,0,0,0,0); `inputBias`=0 | both | 7 | medium | custom kernel weights |
| `CIConvolutionRGB3X3` | 3 by 3 RGB Convolution | Convolution of RGB channels with 3 by 3 matrix | `inputWeights`=(0,0,0,0,1,0,0,0,0); `inputBias`=0 | both | 15 | cheap | custom kernel weights |
| `CIConvolutionRGB5X5` | 5 by 5 RGB Convolution | Convolution of RGB channels with 5 by 5 matrix | `inputWeights`=(0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0); `inputBias`=0 | both | 15 | cheap | custom kernel weights |
| `CIConvolutionRGB7X7` | 7 by 7 RGB Convolution | Convolution of RGB channels with 7 by 7 matrix | `inputWeights`=(0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0); `inputBias`=0 | both | 15 | medium | custom kernel weights |
| `CIConvolutionRGB9Horizontal` | Horizontal 9 RGB Convolution | Horizontal Convolution of RGB channels with 9 values | `inputWeights`=(0,0,0,0,1,0,0,0,0); `inputBias`=0 | both | 15 | medium | custom kernel weights |
| `CIConvolutionRGB9Vertical` | Vertical 9 RGB Convolution | Vertical Convolution of RGB channels with 9 values | `inputWeights`=(0,0,0,0,1,0,0,0,0); `inputBias`=0 | both | 15 | medium | custom kernel weights |
| `CICoreMLModelFilter` | CoreML Model Filter | Generates output image by applying input CoreML model to the input image | `inputModel` (MLModel); `inputHeadIndex`=0 [0…10]; `inputSoftmaxNormalization`=false [false…true] | photo | 12 | heavy | needs a bundled Core ML model |
| `CICrystallize` | Crystallize | Creates polygon-shaped color blocks by aggregating source pixel-color values | `inputRadius`=20 [1…] {1…100}; `inputCenter`=(150,150) | both | 9 | medium |  |
| `CIDepthOfField` | Depth of Field | Simulates miniaturization effect created by Tilt & Shift lens by performing depth of field effects | `inputPoint0`=(0,300); `inputPoint1`=(300,300); `inputSaturation`=1.5 [0…] {0…10}; `inputUnsharpMaskRadius`=2.5 [0…] {0…10}; `inputUnsharpMaskIntensity`=0.5 [0…] {0…10}; `inputRadius`=6 [0…] {0…30} | both | 9 | heavy | fake tilt-shift from two points; several blurs |
| `CIEdgeWork` | Edge Work | Produces a stylized black-and-white rendition of an image that looks similar to a woodblock cutout | `inputRadius`=3 [0…] {0…20} | both | 9 | medium |  |
| `CIEdges` | Edges | Finds all edges in an image and displays them in color | `inputIntensity`=1 [0…] {0…10} | both | 9 | cheap |  |
| `CIGaborGradients` | Gabor Gradients | Applies multichannel 5 by 5 Gabor gradient filter to an image | – | both | 13 | medium |  |
| `CIGloom` | Gloom | Dulls the highlights of an image | `inputRadius`=10 [0…] {0…100}; `inputIntensity`=0.5 [0…] {0…1} | both | 6 | medium | clampedToExtent() then crop; cost grows with radius |
| `CIHeightFieldFromMask` | Height Field From Mask | Produces a continuous three-dimensional, loft-shaped height field from a grayscale mask | `inputRadius`=10 [0…] {0…300} | both | 9 | medium |  |
| `CIHexagonalPixellate` | Hexagonal Pixelate | Displays an image as colored hexagons whose color is an average of the pixels they replace | `inputCenter`=(150,150); `inputScale`=8 [1…] {1…100} | both | 9 | cheap |  |
| `CIHighlightShadowAdjust` | Highlight and Shadow Adjust | Adjust the tonal mapping of an image while preserving spatial detail | `inputRadius`=0 [0…] {0…10}; `inputShadowAmount`=0 [-1…1] {-1…1}; `inputHighlightAmount`=1 [0…1] {0.3…1} | both | 5 | medium |  |
| `CILineOverlay` | Line Overlay | Creates a sketch that outlines the edges of an image in black, leaving the non-outlined portions of the image transparent | `inputNRNoiseLevel`=0.07 [0…] {0…0.1}; `inputNRSharpness`=0.71 [0…] {0…2}; `inputEdgeIntensity`=1 [0…] {0…200}; `inputThreshold`=0.1 [0…] {0…1}; `inputContrast`=50 [0.25…] {0.25…200} | both | 9 | medium | output is black lines on transparent: composite over white or the frame |
| `CIMix` | Mix | Uses an amount parameter to interpolate between an image and a background image | `inputBackgroundImage` (image); `inputAmount`=1 {0…1} | needs backgroundimage | 12 | cheap | blend two images by amount |
| `CIPersonSegmentation` | Person Segmentation | Returns a segmentation mask that is red in the portions of an image that are likely to be persons | `inputQualityLevel`=0 [0…2] {0…2} | both | 15 | heavy | ML mask (low res); prefer Vision + temporal smoothing (see Vision) |
| `CIPixellate` | Pixelate | Makes an image blocky | `inputCenter`=(150,150); `inputScale`=8 [1…] {1…100} | both | 6 | cheap |  |
| `CIPointillize` | Pointillize | Renders the source image in a pointillistic style | `inputRadius`=20 [1…] {1…100}; `inputCenter`=(150,150) | both | 9 | medium |  |
| `CISaliencyMapFilter` | Saliency Map Filter | Generates output image as a saliency map of the input image | – | both | 12 | heavy | ML saliency heat map |
| `CISampleNearest` | Sample Nearest | Produces an image that forces the image sampling to “nearest” mode instead of the default “linear” mode | – | both | 12 | cheap |  |
| `CIShadedMaterial` | Shaded Material | Produces a shaded image from a height field | `inputShadingImage` (image); `inputScale`=10 [0…] {0.5…200} | needs shadingimage | 9 | medium |  |
| `CISobelGradients` | Sobel Gradients | Applies multichannel 3 by 3 Sobel gradient filter to an image | – | both | 17 | cheap |  |
| `CISpotColor` | Spot Color | Replaces one or more color ranges with spot colors | `inputCenterColor1`=rgba(0.0784,0.0627,0.0706,1); `inputReplacementColor1`=rgba(0.4392,0.1922,0.1961,1); `inputCloseness1`=0.22 [0…] {0…0.5}; `inputContrast1`=0.98 [0…] {0…1}; `inputCenterColor2`=rgba(0.5255,0.3059,0.3451,1); `inputReplacementColor2`=rgba(0.9137,0.5608,0.5059,1); `inputCloseness2`=0.15 [0…] {0…0.5}; `inputContrast2`=0.98 [0…] {0…1}; `inputCenterColor3`=rgba(0.9216,0.4549,0.3333,1); `inputReplacementColor3`=rgba(0.9098,0.7529,0.6078,1); `inputCloseness3`=0.5 [0…] {0…0.5}; `inputContrast3`=0.99 [0…] {0…1} | both | 9 | medium |  |
| `CISpotLight` | Spot Light | Applies a directional spotlight effect to an image | `inputLightPosition`=(400,600,150); `inputLightPointsAt`=(200,200,0); `inputBrightness`=3 [0…] {0…10}; `inputConcentration`=0.1 [0.001…] {0.001…1.5}; `inputColor`=rgba(1,1,1,1) | both | 9 | cheap |  |
<!-- END GENERATED:ci-catalog -->

## 3. Channel math (CIColorMatrix, CIColorPolynomial, CIColorCrossPolynomial)

All three are cheap per-pixel filters, video-flagged, iOS 5/7+ (dump), so they run on every frame at no real cost. Core Image applies color filters to unpremultiplied RGBA in its linear working space (Apple docs); video frames are opaque, so alpha rows can stay identity. Follow any custom matrix with `CIColorClamp` (min (0,0,0,0), max (1,1,1,1), dump defaults) so extended-range values don't leak into HDR/10-bit exports.

### 3.1 CIColorMatrix

Dump: `inputRVector`, `inputGVector`, `inputBVector`, `inputAVector`, `inputBiasVector`, all `CIVector` of 4, identity (1,0,0,0) / (0,1,0,0) / (0,0,1,0) / (0,0,0,1) / (0,0,0,0), no min/max. Output per pixel: `R' = dot(RVector, (r,g,b,a)) + bias.x`, and the same for G', B', A'.

| Recipe (`channel_mixer` preset) | R vector | G vector | B vector | Bias | Card title |
|---|---|---|---|---|---|
| `remove_red` | (0,0,0,0) | identity | identity | 0 | Channels · Red removed |
| `remove_green` | identity | (0,0,0,0) | identity | 0 | Channels · Green removed |
| `remove_blue` | identity | identity | (0,0,0,0) | 0 | Channels · Blue removed |
| `isolate_red` (keep only red, looks red) | identity | (0,0,0,0) | (0,0,0,0) | 0 | Channels · Red only |
| `isolate_green` | (0,0,0,0) | identity | (0,0,0,0) | 0 | Channels · Green only |
| `isolate_blue` | (0,0,0,0) | (0,0,0,0) | identity | 0 | Channels · Blue only |
| `swap_rb` | (0,0,1,0) | identity | (1,0,0,0) | 0 | Channels · Red and blue swapped |
| `swap_rg` | (0,1,0,0) | (1,0,0,0) | identity | 0 | Channels · Red and green swapped |
| `swap_gb` | identity | (0,0,1,0) | (0,1,0,0) | 0 | Channels · Green and blue swapped |
| `grayscale_by_red` (red channel shown as gray) | (1,0,0,0) | (1,0,0,0) | (1,0,0,0) | 0 | Channels · Gray from red |
| `grayscale_by_green` | (0,1,0,0) | (0,1,0,0) | (0,1,0,0) | 0 | Channels · Gray from green |
| `grayscale_by_blue` | (0,0,1,0) | (0,0,1,0) | (0,0,1,0) | 0 | Channels · Gray from blue |
| `invert_red` | (−1,0,0,0) | identity | identity | (1,0,0,0) | Channels · Red inverted |
| `invert_green` | identity | (0,−1,0,0) | identity | (0,1,0,0) | Channels · Green inverted |
| `invert_blue` | identity | identity | (0,0,−1,0) | (0,0,1,0) | Channels · Blue inverted |
| `custom` (model-supplied 4x5) | row 0 | row 1 | row 2 | column 4 | Channels · Custom mix |

Intensity blends the preset with identity: `M = I + k·(P − I)`, `bias = k·biasP`, with `k = min(1, 2·intensity)`. So 0.25 → half-way, **0.5 (default) → the full preset**, 0.8/1.0 → full. A channel is either removed or not, so "remove red" must be complete at the default strength (Design: medium must be clearly visible).

Grayscale by luminance is `apply_color_filter` `grayscale` (build 10), not a channel preset. Rec. 709 luma weights for reference: (0.2126, 0.7152, 0.0722) (Apple docs / ITU-R BT.709).

### 3.2 CIColorPolynomial (per-channel curve)

Dump: `inputRedCoefficients`, `inputGreenCoefficients`, `inputBlueCoefficients`, `inputAlphaCoefficients`, `CIVector` of 4, identity (0,1,0,0). Each channel becomes `a0 + a1·x + a2·x² + a3·x³` of itself (Apple docs).

- Invert one channel: that channel (1,−1,0,0). Same result as the matrix recipe.
- Crush or lift a channel: red (0.1,0.9,0,0) lifts red blacks by 10%.
- Gentle S-curve per channel: (0,0,3,−2) (smoothstep), mixed with identity by intensity.

### 3.3 CIColorCrossPolynomial (channels feeding each other, non-linearly)

Dump: `inputRedCoefficients` / `inputGreenCoefficients` / `inputBlueCoefficients`, `CIVector` of 10, identity (1,0,0,0,0,0,0,0,0,0) for red, (0,1,0,…) for green, (0,0,1,…) for blue. Term order (Apple docs, consistent with the dumped identities): `r, g, b, r², g², b², rg, gb, br, 1`.

- Anything `CIColorMatrix` can do, plus squared and cross terms. Example, warmer highlights only: red = (1,0,0,0.1,0,0,0,0,0,0) adds 0.1·r², which is large in bright reds and near zero in shadows.
- Not exposed to the model directly; useful to bake LUTs (§4.3).

## 4. LUTs (CIColorCube family)

| Filter | Dump facts | Use |
|---|---|---|
| `CIColorCube` | `inputCubeDimension` Count, default 2, min 2, **max 64 on iOS 17.5, 128 on 26.5**. `inputCubeData` NSData, default 128 bytes (= 2³ entries × RGBA × Float32). `inputExtrapolate` Boolean, default false | One 3D LUT in the CI working space |
| `CIColorCubeWithColorSpace` | same, plus `inputColorSpace` (CGColorSpace, default nil) | The one to use: LUTs are authored in gamma-encoded sRGB (or Rec.709), so pass `CGColorSpace(name: .sRGB)` and CI converts in and out |
| `CIColorCubesMixedWithMask` | `inputMaskImage` (image), `inputCube0Data`, `inputCube1Data`, `inputColorSpace`, dimension min 2 / max 64 (17.5) / 128 (26.5) | Two grades mixed by a mask: e.g. subject vs background grading with the person mask from §5 |

All three are cheap per frame (a texture lookup) and video-flagged.

### 4.1 Data layout and .cube parsing

- `inputCubeData` is `dimension³` RGBA Float32 values (16 bytes per entry), **red varies fastest, then green, then blue** (Apple docs; the dumped default size confirms Float32 RGBA).
- Adobe/Resolve `.cube` text: `TITLE "…"` (optional), `LUT_3D_SIZE N`, optional `DOMAIN_MIN r g b` / `DOMAIN_MAX r g b` (default 0 and 1), then N³ lines `r g b` with **red fastest**, the same order. Parse each line to three floats, append alpha 1.0, and pass the buffer straight through. Rescale values when DOMAIN is not 0…1. Lines starting with `#` are comments.
- `LUT_1D_SIZE` files are not 3D LUTs: expand them to a small 3D cube, or apply them with `CIColorCurves` (dump: `inputCurvesData` NSData, `inputCurvesDomain` (0,1), `inputColorSpace`).
- Max dimension is 64 on iOS 17 (dump). Common 33 and 65 point LUTs: 33 fits everywhere, 65 must be resampled to 64 or less on iOS 17. Memory: a 33³ cube is 575 KB of Float32; 64³ is 4 MB.

### 4.2 Bundled preset LUT ideas (for `lut`)

Ship our own looks, not third-party LUT files (no licensing questions). Build each by **baking**: render an identity cube (a `dimension³` pixel image whose colours are the grid points) through a Core Image recipe once, read the pixels back as the cube data, and cache them. Baking also makes every look a single cheap lookup per frame, however many filters the recipe has.

| Preset | Card title | Baked recipe (starting point, tune on device) |
|---|---|---|
| `cinematic` | Look · Cinematic | Teal-orange split: shadows toward (0,0.1,0.15), highlights toward (0.15,0.07,0); contrast 1.1 |
| `warm_film` | Look · Warm film | Temperature +1500 K (direction per §9.2), shadows lifted 0.1, saturation 0.9, soft S-curve |
| `cool_film` | Look · Cool film | Temperature −1500 K, slight green tint, matte blacks (floor 0.05) |
| `bleach_bypass` | Look · Bleach bypass | Mix 50% luminance overlay, saturation 0.5, contrast 1.3 |
| `golden_hour` | Look · Golden hour | Warm gain (1.08,1.0,0.85), highlights rolled off, vibrance +0.3 |
| `moody` | Look · Moody | Exposure −0.3 EV, saturation 0.75, blue shadows, contrast 1.15 |
| `matte` | Look · Matte | Black floor 0.08, white ceiling 0.95, saturation 0.9 |
| `vivid` | Look · Vivid | Vibrance +0.5, contrast 1.15 |
| `pastel` | Look · Pastel | Shadows lifted 0.15, saturation 0.7, highlights slightly pink |

Apple's own photo looks (`CIPhotoEffectNoir`, `Chrome`, `Fade`, `Instant`, `Mono`, `Process`, `Tonal`, `Transfer`; dump: each has only `inputExtrapolate` Boolean, default false, all iOS 7+) are also exposed through `lut` as presets (§9.6), except `Transfer`, which is already build 10's `apply_color_filter` `vintage`. They take no strength parameter, so intensity is a mix with the original.

## 5. Vision

Availability and `supportedRevisions` are from the dump (both runtimes unless noted). **Min iOS is the API's introduction version (Apple docs)**; the app's floor is 17. Vision was not executed in the simulator, so cost is an estimate for an A15-class phone at the stated input size. Run Vision on a downscaled copy of the frame (for example 512 px on the long side) and scale the result back up; the mask outputs are low resolution anyway.

| Request | Min iOS (Apple docs) | Revisions (dump) | What we use it for | Photo | Video | Cost per frame (estimate) |
|---|---|---|---|---|---|---|
| `VNGeneratePersonSegmentationRequest` | 15 | [1] | Person matte for background blur/replace/remove, color pop, subject/background grading | `qualityLevel = .accurate` | `.balanced` per frame (Apple recommends `.balanced`/`.fast` for video and says the request object keeps temporal state, so reuse one instance across frames; WWDC21, not verified here) | heavy: measure `.balanced` at 30 fps on the oldest supported phone before promising real-time preview; `.accurate` is photo-only |
| `VNGeneratePersonInstanceMaskRequest` | 17 | [1] | Separate masks for up to 4 people ("blur everyone except me" later) | yes | not recommended (instance order can change between frames) | heavy |
| `VNGenerateForegroundInstanceMaskRequest` | 17 | [1] | Any salient subject (pets, objects, products): background removal/"lift subject" | yes | not in build 11 (no temporal consistency, too slow per frame) | heavy (hundreds of ms per call, estimate) |
| `VNDetectFaceRectanglesRequest` | 11 | [1, 2, 3] | Face boxes for blur/pixelate faces, face-aware crop | yes | yes (every frame, or detect every Nth frame and track with `VNTrackObjectRequest` [1, 2]) | medium |
| `VNDetectFaceLandmarksRequest` | 11 | [1, 2, 3] | Eyes/mouth points (future: sticker anchoring). Not needed in build 11 | yes | possible | medium |
| `VNRecognizeTextRequest` | 13 | [1, 2, 3] | Read on-screen text (keep captions from covering text, find a title frame). Not an edit tool | `.accurate` | `.fast` on sampled frames only | heavy (`.accurate`) / medium (`.fast`) |
| `VNDetectHorizonRequest` | 11 (Apple docs) | [1] | Straighten: returns the horizon angle; apply `CIStraightenFilter` (dump: `inputAngle` radians, slider −π…π, rotates and scales to fill) with the negated angle | yes | analyse ~5 frames, take the median, apply one constant angle (per-frame angles wobble) | cheap |
| `VNGenerateAttentionBasedSaliencyImageRequest` | 13 | [1, 2] | Smart crop: salient bounding boxes → `crop_video` rect or the reframe for `resize_video_preset` 9:16 | yes | sample ~1 fps, smooth the box path, or use the union box for a static crop | medium |
| `VNGenerateObjectnessBasedSaliencyImageRequest` | 13 | [1, 2] | Same, object-based | yes | as above | medium |
| `VNDetectHumanRectanglesRequest` | 13 | [1, 2] | People boxes for reframing | yes | sampled | medium |
| `VNDetectHumanBodyPoseRequest` / `HandPose` / `AnimalBodyPose` | 14 / 14 / 17 | [1] / [1] / [1] | Not needed in build 11 | | | |
| `VNDetectHumanBodyPose3DRequest` | 17 | **[] in the simulator** on both runtimes (no supported revision there) | Not needed | | | |
| `VNTranslationalImageRegistrationRequest` / `VNHomographicImageRegistrationRequest` | 11 | [1] / [1] | Frame-to-frame motion: the building block for stabilization (§7) | – | offline analysis pass | medium per pair |
| `VNGenerateOpticalFlowRequest` | 14 | [1, 2] | Frame interpolation / motion analysis. Not in build 11 | – | too slow for full-length clips | heavy |
| `VNCalculateImageAestheticsScoresRequest` | 18 | **absent on 17.5**, [1] on 26.5 | Pick the best frame for a cover/thumbnail (iOS 18+ only) | yes | sampled | medium |
| `VNDetectLensSmudgeRequest` | 26 (Apple docs, unverified) | absent on 17.5; class present but **[]** revisions on 26.5 simulator | Not useful for editing | | | |
| `CIPersonSegmentation` (Core Image) | 15 (dump) | – | CI wrapper around person segmentation: `inputQualityLevel` Integer 0…2, default 0 (dump). Output mask "may have a different size and aspect ratio" (Apple text in dump) | ok | prefer Vision so we control reuse and smoothing | heavy |

### 5.1 Segmentation on video: making it look right

1. One `VNGeneratePersonSegmentationRequest` instance per export/preview session, `.balanced`, output `kCVPixelFormatType_OneComponent8`.
2. Temporal smoothing we own: keep the previous mask; `mask_t = 0.6·new + 0.4·previous` (our choice), which removes most edge shimmer at the cost of a slight trail on fast motion. Reset on seeks and at composition time discontinuities.
3. Upscale the mask with `CILanczosScaleTransform` (or bilinear via affine), feather it with a small Gaussian blur (radius ≈ 0.002 × short side), then use `CIBlendWithMask` (dump: `inputBackgroundImage`, `inputMaskImage`) to composite subject over the processed background.
4. Background blur: blur the whole frame (clamp, `CIGaussianBlur`, crop) and blend it under the sharp subject, or use `CIMaskedVariableBlur` (dump: `inputMask` image, `inputRadius` default 5, min 0, slider 0…10) with the inverted mask. The two-image blend is cheaper and allows bigger radii.
5. Preview may run below frame rate. Design treats `segment` on video as slow: thin progress bar under the preview while the first frame builds ([`NATIVE_EDIT_UX.md` §8a](NATIVE_EDIT_UX.md)). Export is the ground truth.
6. Alpha output ("remove background") only exists for photos (PNG/HEIC with alpha). MP4/H.264 has no alpha; on video, "remove" means replace with a solid colour (black by default). HEVC-with-alpha in a `.mov` is possible with `AVAssetWriter` (Apple docs) but is not in build 11.

### 5.2 Faces

Detect with `VNDetectFaceRectanglesRequest` on every Nth frame (N = 3 at 30 fps, our choice) and track between detections with `VNTrackObjectRequest`, or just interpolate boxes. Grow each box by 20% so hair and chin are covered, build a soft elliptical mask (`CIRadialGradient`), and blend a `CIPixellate` or `CIGaussianBlur` copy through it. A missed detection shows the face for a frame, so for privacy blur hold the last box for 0.5 s after a face disappears.

## 6. AVFoundation audio

Parameter ranges below are the `auAudioUnit.parameterTree` values from the dump (`platform-ios*.json`), identical on 17.5 and 26.5. Preset enum names are from Apple docs (the parameter tree doesn't list them). All of these are `AVAudioUnitEffect` subclasses that run inside `AVAudioEngine`. They don't plug into `AVPlayerItem` directly, which is why audio effects go through an offline render (§6.7).

### 6.1 AVAudioUnitEQ

- `AVAudioUnitEQ(numberOfBands:)`; each `AVAudioUnitEQFilterParameters` band has `filterType`, `frequency`, `bandwidth`, `gain`, `bypass`.
- **Filter types (dump, parameter 2000 value strings, 11):** Parametric, Butterworth Low Pass, Butterworth High Pass, Resonant Low Pass, Resonant High Pass, Band Pass, Band Stop, Low Shelf, High Shelf, Resonant Low Shelf, Resonant High Shelf.
- **Frequency** 10…21609 Hz (dump; the upper bound tracks the sample rate, so clamp to 0.45 × sample rate). **Gain** −96…24 dB. **Bandwidth** 0.05…5 octaves. **Global gain** −96…24 dB. New band defaults (dump): 40 Hz, 0.5 octave, 0 dB, Parametric, **bypass = true** (set `bypass = false` or the band does nothing).

### 6.2 AVAudioUnitReverb

- `loadFactoryPreset(_:)` presets (Apple docs, 13): smallRoom, mediumRoom, largeRoom, mediumHall, largeHall, plate, mediumChamber, largeChamber, cathedral, largeRoom2, mediumHall2, mediumHall3, largeHall2.
- `wetDryMix` 0…100 % (dump), **default 0.5 %** (dump), which is effectively dry, so always set it.
- The underlying AU also exposes (dump) Gain −20…20 dB, Min/Max Delay Time 0.0001…1 s, Low/High Freq Decay Time 0.001…20 s, Randomize Reflections 1…1000. Presets set these; we only touch `wetDryMix`.

### 6.3 AVAudioUnitDelay

Dump: `delayTime` 0.0001…2 s (default 1), `feedback` −99.9…99.9 % (default 50), `lowPassCutoff` 10…22050 Hz (default 15000), `wetDryMix` 0…100 % (default 50).

### 6.4 AVAudioUnitDistortion

- `loadFactoryPreset(_:)` presets (Apple docs, 22): drumsBitBrush, drumsBufferBeats, drumsLoFi, multiBrokenSpeaker, multiCellphoneConcert, multiDecimated1…4, multiDistortedFunk, multiDistortedCubed, multiDistortedSquared, multiEcho1, multiEcho2, multiEchoTight1, multiEchoTight2, multiEverythingIsBroken, speechAlienChatter, speechCosmicInterference, speechGoldenPi, speechRadioTower, speechWaves.
- `preGain` = AU "Soft Clip Gain" −80…20 dB (dump, default −0.9); `wetDryMix` 0…100 % (dump default 44.6). The tree also has delay 0.1…500 ms, decay 0.1…50, ring-mod freq 0.5…8000 Hz ×2, ring-mod balance/mix 0…100 %, decimation/rounding 0…100 %, polynomial linear 0…1 / squared 0…20 / cubic 0…20 (dump). Presets set these.

### 6.5 AVAudioUnitTimePitch and AVAudioUnitVarispeed

- TimePitch (dump): **pitch −2400…2400 cents** (±2 octaves, default 0), **rate 1/32…32** (0.03125…32, default 1), overlap ("smoothness") 3…32 (default 8). Pitch changes without changing duration.
- Varispeed (dump): **rate 0.25…4** (default 1), pitch follows rate (tape-style; the tree's playback-pitch parameter is −2400…2400 cents).
- Speed changes of the whole clip stay on `adjust_speed` (composition `scaleTimeRange` + `audioTimePitchAlgorithm`); these units are for voice effects.

### 6.6 Volume, fades, noise gate

- **Volume ≤ 1 and fades:** `AVMutableAudioMixInputParameters.setVolume` / `setVolumeRamp` (build 10, no render). Gain > 1 needs the offline render.
- **Noise gate:** AVFoundation has no gate unit. Options: (a) our own Swift DSP in the offline render (envelope follower → threshold with hold → attack/release gain ramp, `vDSP` for speed). Deterministic and already planned in `native-tools.md` (`audio_gate`). (b) Apple's `kAudioUnitSubType_DynamicsProcessor` via `AVAudioUnitEffect(audioComponentDescription:)`; it has expansion ratio/threshold parameters that act as a soft gate (Apple docs, not dumped). (c) `MTAudioProcessingTap` on the audio mix runs custom DSP in real time during playback and export without an offline pass, but it's C callback code and hosting AUs inside it is fiddly. **Recommendation: (a).**
- **Noise reduction / voice isolation:** no public API for files. The system voice-isolation mode is microphone-capture only. Not on device.

### 6.7 Export path for audio effects

1. Read the composition's audio (after trim/speed) with `AVAssetReader` + `AVAssetReaderAudioMixOutput` (applies the current `AVAudioMix` volume ramps), decoding to Float32 PCM.
2. Build an `AVAudioEngine`, call `enableManualRenderingMode(.offline, format:, maximumFrameCount:)`, attach `AVAudioPlayerNode` → effect units (EQ, reverb, delay, time-pitch, distortion) → `mainMixerNode`, schedule the PCM buffers, `start()`, and loop `renderOffline(_:to:)` writing each block to an `AVAudioFile` (`.caf`, Float32). Custom DSP (gate, gain > 1) runs on the buffers before or after the engine.
3. Reverb and echo tails ring past the last sample: render ~2 s of silence after the input, then truncate to the video duration with a 50 ms fade so the clip doesn't end on a click.
4. Replace the composition's audio track with the rendered file (`removeTimeRange` + `insertTimeRange` from an `AVURLAsset` of the `.caf`). Preview and `AVAssetExportSession` then use it with no further work.
5. Cache by (source audio identity, ordered effect parameters). Every parameter change re-renders the whole clip; on a phone that's much faster than real time (estimate), but for clips longer than ~15 s it passes Design's 1.5 s threshold, so `audio_effect` shows the progress bar.

## 7. Geometry and time

| Capability | On device? | How | Cost / notes |
|---|---|---|---|
| Trim, cut, speed (0.25…4×), crop, rotate, flip, resize, pad to aspect | Yes (build 10) | Composition time ops + CI affine chain (`native-tools.md` §2.1) | cheap |
| Straighten / fix horizon | Yes | `VNDetectHorizonRequest` → `CIStraightenFilter` (dump: rotates and scales to fill) | cheap. Candidate: add an `angle: "auto"` mode to `rotate_video` later, no new tool needed |
| Keystone / perspective fix | Yes, photo-first | `VNDetectRectanglesRequest` [1] corners → `CIPerspectiveCorrection` (dump: 4 corner points, `inputCrop` Boolean) | cheap. Not in build 11 |
| Smart crop / auto reframe to 9:16 | Yes | Saliency or human rectangles → crop rect. Static: union of boxes over sampled frames. Dynamic: smoothed box path per frame (medium) | Candidate for a later `resize_video_preset` `reframe: "subject"` flag |
| Freeze frame | Yes | `scaleTimeRange` a one-frame range to N seconds (the frame holds), audio gap filled with silence via `insertEmptyTimeRange` | cheap. Not in build 11 |
| Reverse | Yes, with cost | Decode frames with `AVAssetReader`, write them in reverse with `AVAssetWriter` (needs a temp file; GOP decoding means buffering segments). Audio: reverse PCM | heavy, proportional to length; needs the export progress UI |
| Boomerang / loop | Yes | Insert the range N times; boomerang = forward + reversed copy | loop cheap, boomerang as reverse |
| Speed ramp (variable speed) | Yes | Several `scaleTimeRange` segments | cheap |
| Fade to/from black, crossfade within one clip | Yes | CI chain opacity at `compositionTime` | cheap |
| Transitions between clips | Yes, when multi-clip exists | Two tracks + CI transition filters (§2, 11 of them) with `inputTime` from composition time | cheap to medium. Needs multi-clip import (not in the iOS UI yet) |
| Picture-in-picture | Yes, when multi-clip exists | Second video track, `CISourceOverCompositing` of a scaled/offset frame (custom `AVVideoCompositing` or two sources in one compositor) | medium |
| Text, captions, stickers | Yes (build 10 text/captions) | Core Text → `CGImage` composited per frame | cheap |
| Frame-rate change | Partial | `AVMutableVideoComposition.frameDuration` drops/duplicates frames. No motion interpolation | cheap |
| Stabilization | **No (not build 11)** | No public API stabilizes an existing file (`AVCaptureConnection` stabilization is capture-time only, Apple docs). Feasible later: Vision registration per frame pair → smooth the camera path → crop+warp per frame. Multi-pass, heavy | would be a separate project |
| Frame interpolation / smooth slow-mo | **No** | Optical flow (`VNGenerateOpticalFlowRequest`) too slow for full clips. VideoToolbox `VTFrameProcessor` (frame-rate conversion, super-resolution, motion blur, temporal noise filter) is iOS 26+ only (Apple docs, not dumped, not evaluated) | revisit when the floor is iOS 26 |
| AI upscaling / super-resolution | **No** (iOS 17). Maybe via `VTFrameProcessor` on iOS 26+ (Apple docs) | – | |
| Object removal / inpainting ("remove the person in the back") | **No** | No public inpainting API (the Photos Clean Up tool isn't available to apps) | |
| Generative background replacement ("put me on a beach") | **No** | Needs a generative model; replace works only with a solid colour, blur or gradient | |
| Voice isolation / noise reduction on files | **No** | Mic-capture only; gate is the on-device substitute (§6.6) | |
| Chorus, flanger, phaser, vibrato, stereo widen | **No AU** | Custom DSP later (`native-tools.md` §2.2 GAP list) | |
| Formats: webm, avi, mkv, flv, ogv; mp3, ogg, flac, wma; webp write | **No** | No AVFoundation/ImageIO writers (`native-tools.md` §2.3) | |
| Translation of captions | **No** (in the edit path) | – | |

## 8. Proposed iOS tool list (build 11)

"Build 11" here means **the first build that ships the grouped-tool executor**. Builds number automatically ([`NATIVE_EDIT_UX.md` §8a](NATIVE_EDIT_UX.md)), so Backend sets `minBuild` to the build number iOS posts as the first one running these tools.

**Build 11 = build 10's 21 tools − the 4 `adjust_*` tools + 9 grouped tools = 26 tools.** Build 10 keeps exactly its 21.

| # | Tool | Status in build 11 | One line |
|---|---|---|---|
| 1 | `trim_video` | kept | Cut to a time range |
| 2 | `adjust_speed` | kept | 0.25–4× speed |
| 3 | `crop_video` | kept | Crop to a rectangle |
| 4 | `rotate_video` | kept | Rotate by degrees |
| 5 | `flip_video_horizontal` | kept | Mirror left-right |
| 6 | `flip_video_vertical` | kept | Flip upside down |
| 7 | `resize_video` | kept | Scale to a size |
| 8 | `resize_video_preset` | kept | Fit to 9:16, 16:9, 1:1, 2:3, 3:2 |
| 9 | `apply_color_filter` | kept, description sharpened (§8.2) | Simple tints and classic named colour looks (red…magenta, sepia, grayscale, black_and_white, invert, warm, cool, vintage) |
| 10 | `add_text` | kept | Text overlay |
| 11 | `adjust_audio_volume` | kept | Volume |
| 12 | `audio_fade` | kept | Audio fade in/out |
| 13 | `get_video_dimensions` | kept | Size/duration/fps of the edited clip |
| 14 | `get_supported_formats` | kept | Formats the phone can write |
| 15 | `convert_video_format` | kept (mp4/mov) | Export container |
| 16 | `convert_image_format` | kept (jpg/png) | Photo export format |
| 17 | `generate_captions` | kept | On-device captions, burn-in or soft track |
| 18 | `channel_mixer` | **new** | Remove, isolate, swap, invert or gray-out RGB channels |
| 19 | `color_adjust` | **new** (absorbs the 4 retired `adjust_*`) | Exposure, contrast, saturation, vibrance, warmth, tint, shadows, highlights, midtones, hue |
| 20 | `apply_filter` | **new** | Named special effects no other tool covers: distortions, kaleidoscope/tiles, halftone screens, custom tints, light overlays |
| 21 | `stylize` | **new** | Artistic styles: comic, posterize, pixelate, crystallize, pointillize, edges, woodcut, sketch, thermal, x-ray, glow, gloom, colour splash |
| 22 | `blur_sharpen` | **new** | Blur, motion/zoom/lens blur, tilt-shift, sharpen, denoise |
| 23 | `lut` | **new** | Named film/photo looks: Apple photo effects plus 9 bundled grades |
| 24 | `vignette_grain` | **new** | Vignette and film grain |
| 25 | `segment` | **new** | Background blur/replace/remove, colour pop, darken background, blur/pixelate faces |
| 26 | `audio_effect` | **new** (video only) | EQ presets, reverb, echo, pitch, robot/radio/distortion, noise gate |
| – | `adjust_brightness`, `adjust_contrast`, `adjust_saturation`, `adjust_hue` | **retired for build 11+** (allowlist `maxBuild: 10`) | Not offered to the model. The iOS executor **keeps accepting all four names** (old chats, stale schema) and maps them onto `color_adjust` with the exact build-10 values, same "Color · …" card titles |

### 8.1 Backend changes (proposal, not implemented here)

- `IOS_TOOL_ALLOWLIST` gains a max build: `adjust_brightness`, `adjust_contrast`, `adjust_saturation`, `adjust_hue` → `{ minBuild: 10, maxBuild: 10 }`; the 9 grouped tools → `{ minBuild: <first executor build> }`.
- `mediaTypes`: every grouped tool is `["video", "image"]` except `audio_effect` (`["video"]`).
- The 9 definitions and the `apply_color_filter` description override are in [`data/proposed-tools-build11.json`](data/proposed-tools-build11.json) (also embedded in §9.11). They are iOS-only tools; the web tool list doesn't change.
- Retired mapping, executor side (pixel-identical to build 10):

| Retired call | Executed as | Card |
|---|---|---|
| `adjust_brightness { brightness: b }` | `color_adjust { adjust: [b ≥ 0 ? "brighter" : "darker"], values: { brightness: b } }` (`CIColorControls.inputBrightness`, clamp −1…1) | Color · Brighter / Darker |
| `adjust_contrast { contrast: c }` | `values.contrast = c` (`inputContrast`, build-10 clamp 0…3) | Color · More contrast / Less contrast |
| `adjust_saturation { saturation: s }` | `values.saturation = s` (`inputSaturation`, build-10 clamp 0…3) | Color · More saturated / Muted |
| `adjust_hue { degrees: d }` | `values.hue_degrees` = d wrapped to −180…180 (`CIHueAdjust`, radians) | Color · Hue shifted |

### 8.2 Overlap: who owns which look word

The model picks inconsistently when two tools both plausibly fit. Rule: **every look word appears in exactly one tool's enum**, and each description names the other tools for the neighbouring words.

| Tool | Owns | Test: the words the user says |
|---|---|---|
| `apply_color_filter` (build 10, frozen) | Colour tints and classic colour looks: red, green, blue, yellow, cyan, magenta, sepia, grayscale, black_and_white, invert, warm, cool, vintage | "red filter", "black and white", "sepia", "vintage", "warm tones" |
| `color_adjust` | Amount-based corrections | "warmer", "a bit brighter", "more contrast", "less saturated", "lift shadows" |
| `lut` | Film/photo grades | "noir", "cinematic", "film look", "faded", "Polaroid", "moody", "golden hour" |
| `stylize` | Structure-changing artistic styles | "comic", "cartoon", "pixelate", "sketch", "thermal", "x-ray", "dreamy glow", "keep only the reds" |
| `apply_filter` | Special effects nobody else has | "twirl", "fisheye/bulge", "kaleidoscope", "halftone", "lens flare", "tint it purple" |
| `channel_mixer` | Anything that names an RGB channel | "remove the red channel", "swap red and blue" |
| `blur_sharpen` / `vignette_grain` / `segment` | Blur/sharpen / corners and grain / person-aware | "blur it" vs "blur the background" (segment) |

**Recommendations to reduce overlap:**

1. **Move Apple's photo effects out of `stylize` into `lut`.** The original brief listed noir, sepia, chrome, fade, instant, process, tonal, transfer and mono as `stylize` presets. They are colour grades, not structural styles, and sepia/transfer duplicate `apply_color_filter` `sepia`/`vintage` (build 10 already implements vintage as `CIPhotoEffectTransfer`). So `lut` owns noir, chrome, fade, instant, mono, process, tonal; `sepia` and `transfer`/vintage stay only in `apply_color_filter`; `stylize` keeps only structural effects. The executor still accepts the old names on `stylize` (and `transfer`/`sepia` on `lut`) and routes them to the same implementation, so a stale schema doesn't fail.
2. **Keep `apply_color_filter` frozen**, with the sharper description in the JSON (`iosOverrides`) pointing film looks to `lut` and artistic styles to `stylize`. Merging it into `lut` would break build 10 chats and its chip ("Red filter") for no user benefit.
3. **Limit `apply_filter` to effects nobody else covers.** Its enum excludes every filter reachable through another tool (no blurs, no photo effects, no comic/pixellate, no colour controls). If the model still sends such a name, the executor routes it to the owning tool. A name that isn't in the on-device catalog at all returns `unsupported_on_device`.
4. "Black and white" has three near-synonyms (`apply_color_filter` grayscale / black_and_white, `lut` mono/noir/tonal, `channel_mixer` grayscale_by_X). Descriptions route plain "black and white" to `apply_color_filter`, "noir"/"film" to `lut`, and anything naming a channel to `channel_mixer`.

### 8.3 Contract for every grouped tool

- Works on video (per frame in the `AVVideoComposition` CI chain) and photo, except `audio_effect` (video only; photo → `{ ok: false, error: "unsupported_for_photo" }`, card `edit.failed.photoUnsupported`) and `segment` `subject: "any"` on video (→ `unsupported_on_device`).
- **Out-of-range numbers are clamped, never rejected**: schema bounds first, then the dumped `[min…max]`; when Apple gives no hard bound, the dumped slider range (§9.0). The result may list what was clamped in `output.clamped: ["param", …]` (clients and server ignore unknown fields).
- Unsupported (unknown enum value, filter not in this device's catalog, `subject:"any"` on video): `{ "ok": false, "code": "unsupported_on_device", "executedOn": "device" }` (build 10 sent `error`; the server accepts both).
- `intensity` 0…1, default 0.5. **Vocabulary (Design §8a): "a bit"/"slightly" = 0.25, no qualifier = 0.5, "a lot"/"very"/"really" = 0.8.** 0.5 is tuned to be clearly visible on a phone screen. Explicit parameters override intensity. Card strength word: intensity < 0.4 → "Light" (blur: "Soft"), < 0.7 → "Medium", otherwise "Strong".
- **"More"/"less" follow-ups** replace the last card's parameters for the same tool (Design §8a): "more" = intensity + 0.25, "less" = intensity − 0.25, clamped to 0.1…1.
- Card titles: "{Group} · {what changed}", at most two changes then "+{n} more". Every preset below has its title. Slow tools (progress bar under the preview, never a dimmer) are flagged **Slow on video**.

## 9. Proposed iOS tool schemas (build 11)

### 9.0 Clamping and scaling rules (all tools)

- Scalars: clamp to the schema bounds; for raw Core Image `params` (apply_filter only), clamp to the dumped `min`/`max`, and where either is missing, to `sliderMin`/`sliderMax`.
- `Distance` inputs (radii, widths, scales in px) are specified at a **1080p reference** and multiplied by `min(w, h) / 1080` before clamping, so looks match between thumbnails, 720p video and 12 MP photos.
- `Position` inputs come from `center_x`/`center_y` (0…1, top-left origin) → CI coordinates (bottom-left origin). Default: frame centre.
- Generic intensity curve for a strength parameter p with identity (no-op) value `p0`, medium value `pm` and maximum `p1`: `p(i) = p0 + (pm − p0)·2i` for i ≤ 0.5, `pm + (p1 − pm)·(2i − 1)` above. `pm` is Apple's default when that differs from identity (Apple tunes defaults to be visible), otherwise the midpoint, unless a table says "our curve". `p1` is the slider maximum.
- "Mix" presets (no strength parameter): `out = mix(original, effect, k)`, `k = min(1, 2i)`. So 0.25 = half strength, **0.5 = the full effect**, and above 0.5 we add contrast `1 + 0.3·(2i − 1)` on top, so "very noir" is visibly stronger than "noir" without inverting colours.

### 9.1 `channel_mixer`

Card group **Channels**. Presets, matrices and titles: §3.1. Intensity: `k = min(1, 2·intensity)`, matrix blended with identity; 0.5 applies the preset fully (§3.1). `custom`: 4×5 rows, coefficients clamped −2…2, bias −1…1, followed by `CIColorClamp`. Cost cheap, not slow.

### 9.2 `color_adjust`

Card group **Color**. One CI chain in this fixed order: exposure → temperature/tint → highlights/shadows → gamma → `CIColorControls` (contrast, saturation, brightness) → vibrance → hue. Ranges are from the dump except where marked.

| `adjust` value | Card words | Filter.input (dump range) | 0.25 / **0.5** / 0.8 / 1.0 | `values` override (clamp) |
|---|---|---|---|---|
| `brighter` / `darker` | Brighter / Darker | `CIExposureAdjust.inputEV` (slider −10…10, identity 0) | ±0.375 / **±0.75** / ±1.2 / ±1.5 EV | `exposure_ev` −3…3 (our bound inside the slider) |
| `more_contrast` / `less_contrast` | More contrast / Less contrast | `CIColorControls.inputContrast` (min 0, slider 0.25…4, identity 1) | 1.15 / **1.3** / 1.48 / 1.6 · or 0.85 / **0.7** / 0.52 / 0.4 | `contrast` 0.25…4 |
| `more_saturation` / `less_saturation` | More saturated / Muted | `CIColorControls.inputSaturation` (min 0, slider 0…2, identity 1) | 1.25 / **1.5** / 1.8 / 2.0 · or 0.75 / **0.5** / 0.2 / 0 | `saturation` 0…2 |
| `more_vibrance` / `less_vibrance` | More vibrant / Less vibrant | `CIVibrance.inputAmount` (min/max −1…1, identity 0) | ±0.25 / **±0.5** / ±0.8 / ±1 | `vibrance` −1…1 |
| `warmer` / `cooler` | Warmer / Cooler | `CITemperatureAndTint.inputNeutral.x` with `inputTargetNeutral` = (6500, 0) (dump: both default/identity (6500, 0), no range) | 6500 ± 1000 / **± 2000** / ± 3200 / ± 4000 K | `temperature_shift_k` −4000…4000 (our bound) |
| `greener` / `more_magenta` | Greener / More magenta | `CITemperatureAndTint.inputNeutral.y` (identity 0, no range) | ∓/± 25 / **50** / 80 / 100 | `tint_shift` −100…100 (our bound) |
| `lift_shadows` / `deepen_shadows` | Shadows lifted / Deeper shadows | `CIHighlightShadowAdjust.inputShadowAmount` (min/max −1…1, identity 0) | ±0.25 / **±0.5** / ±0.8 / ±1 | `shadows` −1…1 |
| `recover_highlights` | Highlights softened | `CIHighlightShadowAdjust.inputHighlightAmount` (min/max 0…1, slider 0.3…1, identity 1) | 0.825 / **0.65** / 0.44 / 0.3 | `highlights` 0.3…1 |
| `brighter_midtones` / `darker_midtones` | Brighter midtones / Darker midtones | `CIGammaAdjust.inputPower` (slider 0.25…4, identity 1) | 1/(1+i): 0.8 / **0.67** / 0.56 / 0.5 · or 1+i: 1.25 / **1.5** / 1.8 / 2 | `gamma` 0.25…4 |
| `hue_shift` | Hue shifted | `CIHueAdjust.inputAngle` (slider −π…π, identity 0) | 45° / **90°** / 144° / 180° | `hue_degrees` −180…180 |
| (compat only) | Brighter / Darker | `CIColorControls.inputBrightness` (min −1, slider −1…1) | not driven by intensity | `brightness` −1…1 |

Warm/cool direction: `CITemperatureAndTint` maps the source white point `inputNeutral` to `inputTargetNeutral`. A source neutral **above** 6500 K is treated as too blue and corrected toward warm, so warmer = `inputNeutral.x = 6500 + shift` (Apple docs semantics; **verify the direction, and the sign of tint, on device** before shipping, since the dump has no ranges for this filter). Cost: cheap (highlights/shadows is medium). Not slow. Title example: `{adjust:["brighter","more_contrast"]}` → "Color · Brighter, more contrast".

### 9.3 `apply_filter`

Card group **Look** (`Look · {card title}`). The enum is the video-safe subset of the catalog that no other tool reaches. `params` accepts raw CI input names from the catalog and clamps them (§9.0); unknown keys are ignored. Centers come from `center_x`/`center_y`; distortion radii default to `0.35 × min(w,h)` instead of Apple's 300 px (our choice, so the effect covers a sensible part of the frame). `color`/`color2` fill `inputColor`/`inputColor0`/`inputColor1`. Generators (sunbeams, lens flare, star shine) are cropped to the frame and composited with `CIScreenBlendMode`; intensity is their opacity. Intensity curves use the dumped identity/default/slider values (§9.0) unless marked "our curve":

<!-- BEGIN GENERATED:apply-filter -->
| `name` (enum) | Core Image filter | Card title | Intensity drives | 0 / 0.25 / **0.5** / 0.8 / 1.0 | Other params (dumped defaults) | Min iOS | Cost |
|---|---|---|---|---|---|---|---|
| `twirl` | `CITwirlDistortion` | Look · Twirl | `inputAngle` | 0 / 1.571 / **3.142** / 8.796 / 12.57 | `inputCenter`=(150,150); `inputRadius`=300 [0…] {0…500} | 5 | cheap |
| `vortex` | `CIVortexDistortion` | Look · Vortex | `inputAngle` | 0 / 28.27 / **56.55** / 79.17 / 94.25 | `inputCenter`=(150,150); `inputRadius`=300 [0…] {0…800} | 6 | cheap |
| `bulge` | `CIBumpDistortion` | Look · Bulge | `inputScale` | 0 / 0.25 / **0.5** / 0.8 / 1 | `inputCenter`=(150,150); `inputRadius`=300 [0…] {0…600} | 6 | cheap |
| `bulge_line` | `CIBumpDistortionLinear` | Look · Bulge band | `inputScale` (our curve) | 0 / 0.25 / **0.5** / 0.8 / 1 | `inputCenter`=(150,150); `inputRadius`=300 [0…] {0…600}; `inputAngle`=0 {0…2π} | 6 | cheap |
| `pinch` | `CIPinchDistortion` | Look · Pinch | `inputScale` | 0 / 0.25 / **0.5** / 1.4 / 2 | `inputCenter`=(150,150); `inputRadius`=300 [0…] {0…1000} | 6 | cheap |
| `circle_splash` | `CICircleSplashDistortion` | Look · Circle splash | `inputRadius` | 0 / 75 / **150** / 660 / 1000 | `inputCenter`=(150,150) | 6 | cheap |
| `hole` | `CIHoleDistortion` | Look · Hole | `inputRadius` | 0.1 / 75.05 / **150** / 660 / 1000 | `inputCenter`=(150,150) | 6 | cheap |
| `light_tunnel` | `CILightTunnel` | Look · Light tunnel | `inputRotation` | 0 / 0.3927 / **0.7854** / 1.257 / 1.571 | `inputCenter`=(150,150); `inputRadius`=100 {1…500} | 6 | cheap |
| `torus_lens` | `CITorusLensDistortion` | Look · Ring lens | `inputRefraction` | 1 / 1.35 / **1.7** / 3.68 / 5 | `inputCenter`=(150,150); `inputRadius`=160 [0…] {0…500}; `inputWidth`=80 [0…] {0…200} | 9 | medium |
| `glass_lozenge` | `CIGlassLozenge` | Look · Glass lens | `inputRefraction` | 1 / 1.35 / **1.7** / 3.68 / 5 | `inputPoint0`=(150,150); `inputPoint1`=(350,150); `inputRadius`=100 [0…] {0…1000} | 9 | medium |
| `circular_wrap` | `CICircularWrap` | Look · Circle wrap | `inputAngle` | 0 / 0.7854 / **1.571** / 2.513 / 3.142 | `inputCenter`=(150,150); `inputRadius`=150 [0…] {0…600} | 9 | cheap |
| `droste` | `CIDroste` | Look · Infinite spiral | `inputZoom` | 0.01 / 0.505 / **1** / 3.4 / 5 | `inputInsetPoint0`=(200,200); `inputInsetPoint1`=(400,400); `inputStrands`=1 [-10…10] {-2…2}; `inputPeriodicity`=1 [1…] {1…5}; `inputRotation`=0 {0…2π} | 9 | heavy |
| `kaleidoscope` | `CIKaleidoscope` | Look · Kaleidoscope | mix with original | mix 0 / 50% / **100%** / 100% / 100% | `inputCount`=6 [1…] {1…64}; `inputCenter`=(150,150); `inputAngle`=0 {-π…π} | 9 | cheap |
| `triangle_kaleidoscope` | `CITriangleKaleidoscope` | Look · Triangle kaleidoscope | mix with original | mix 0 / 50% / **100%** / 100% / 100% | `inputPoint`=(150,150); `inputSize`=700 {0…1000}; `inputRotation`=5.924 {0…2π}; `inputDecay`=0.85 {0…1} | 6 | cheap |
| `op_art_tile` | `CIOpTile` | Look · Op art | `inputScale` | 1 / 1.9 / **2.8** / 7.12 / 10 | `inputCenter`=(150,150); `inputAngle`=0 {-π…π}; `inputWidth`=65 [0…] {1…1000} | 9 | cheap |
| `mirror_tile_4` | `CIFourfoldReflectedTile` | Look · Mirror tiles | mix with original | mix 0 / 50% / **100%** / 100% / 100% | `inputCenter`=(150,150); `inputAngle`=0 {-π…π}; `inputWidth`=100 [0…] {1…200}; `inputAcuteAngle`=π/2 {-π…π} | 6 | cheap |
| `rotated_tile_6` | `CISixfoldRotatedTile` | Look · Rotated tiles | mix with original | mix 0 / 50% / **100%** / 100% / 100% | `inputCenter`=(150,150); `inputAngle`=0 {-π…π}; `inputWidth`=100 [0…] {1…200} | 6 | cheap |
| `mirror_tile_8` | `CIEightfoldReflectedTile` | Look · Mirror tiles ×8 | mix with original | mix 0 / 50% / **100%** / 100% / 100% | `inputCenter`=(150,150); `inputAngle`=0 {-π…π}; `inputWidth`=100 [0…] {1…200} | 6 | cheap |
| `mirror_tile_12` | `CITwelvefoldReflectedTile` | Look · Mirror tiles ×12 | mix with original | mix 0 / 50% / **100%** / 100% / 100% | `inputCenter`=(150,150); `inputAngle`=0 {-π…π}; `inputWidth`=100 [0…] {1…200} | 6 | cheap |
| `dot_screen` | `CIDotScreen` | Look · Dot screen | `inputWidth` (our curve) | 2 / 7 / **12** / 34.8 / 50 | `inputCenter`=(150,150); `inputAngle`=0 {-π…π}; `inputSharpness`=0.7 [0…1] {0…1} | 6 | cheap |
| `line_screen` | `CILineScreen` | Look · Line screen | `inputWidth` (our curve) | 2 / 7 / **12** / 34.8 / 50 | `inputCenter`=(150,150); `inputAngle`=0 {-π…π}; `inputSharpness`=0.7 [0…1] {0…1} | 6 | cheap |
| `hatched_screen` | `CIHatchedScreen` | Look · Crosshatch | `inputWidth` (our curve) | 2 / 7 / **12** / 34.8 / 50 | `inputCenter`=(150,150); `inputAngle`=0 {-π…π}; `inputSharpness`=0.7 [0…1] {0…1} | 6 | cheap |
| `circular_screen` | `CICircularScreen` | Look · Ring screen | `inputWidth` (our curve) | 2 / 7 / **12** / 34.8 / 50 | `inputCenter`=(150,150); `inputSharpness`=0.7 [0…1] {0…1} | 6 | cheap |
| `cmyk_halftone` | `CICMYKHalftone` | Look · Print halftone | `inputWidth` (our curve) | 2 / 7 / **12** / 64.8 / 100 | `inputCenter`=(150,150); `inputAngle`=0 {-π…π}; `inputSharpness`=0.7 [0…] {0…1}; `inputGCR`=1 [0…] {0…1}; `inputUCR`=0.5 [0…] {0…1} | 9 | cheap |
| `monochrome_tint` | `CIColorMonochrome` | Look · One-color tint | `inputIntensity` | 0 / 0.5 / **1** / 1 / 1 | `inputColor`=rgba(0.6,0.45,0.3,1) | 5 | cheap |
| `duotone` | `CIFalseColor` | Look · Duotone | mix with original | mix 0 / 50% / **100%** / 100% / 100% | `inputColor0`=rgba(0.3,0,0,1); `inputColor1`=rgba(1,0.9,0.8,1) | 5 | cheap |
| `white_point` | `CIWhitePointAdjust` | Look · White point | mix with original | mix 0 / 50% / **100%** / 100% / 100% | `inputColor`=rgba(1,1,1,1) | 5 | cheap |
| `dither` | `CIDither` | Look · Dither | `inputIntensity` | 0 / 0.05 / **0.1** / 0.64 / 1 |  | 12 | medium |
| `max_component_gray` | `CIMaximumComponent` | Look · Bright gray | mix with original | mix 0 / 50% / **100%** / 100% / 100% | – | 6 | cheap |
| `min_component_gray` | `CIMinimumComponent` | Look · Dark gray | mix with original | mix 0 / 50% / **100%** / 100% / 100% | – | 6 | cheap |
| `threshold` | `CIColorThreshold` | Look · Two-tone | `inputThreshold` | 0 / 0.25 / **0.5** / 0.8 / 1 |  | 14 | cheap |
| `sunbeams` | `CISunbeamsGenerator` | Look · Sunbeams | overlay opacity (screen blend) | opacity 0 / 50% / **100%** / 100% / 100% | `inputCenter`=(150,150); `inputColor`=rgba(1,0.5,0,1); `inputSunRadius`=40 [0…] {0…800}; `inputMaxStriationRadius`=2.58 [0…] {0…10}; `inputStriationStrength`=0.5 [0…] {0…3}; `inputStriationContrast`=1.375 [0…] {0…5}; `inputTime`=0 [0…1] {0…1} | 9 | medium |
| `lens_flare` | `CILenticularHaloGenerator` | Look · Lens flare | overlay opacity (screen blend) | opacity 0 / 50% / **100%** / 100% / 100% | `inputCenter`=(150,150); `inputColor`=rgba(1,0.9,0.8,1); `inputHaloRadius`=70 [0…] {0…1000}; `inputHaloWidth`=87 [0…] {0…300}; `inputHaloOverlap`=0.77 [0…] {0…1}; `inputStriationStrength`=0.5 [0…] {0…3}; `inputStriationContrast`=1 [0…] {0…5}; `inputTime`=0 [0…1] {0…1} | 9 | medium |
| `star_shine` | `CIStarShineGenerator` | Look · Star shine | overlay opacity (screen blend) | opacity 0 / 50% / **100%** / 100% / 100% | `inputCenter`=(150,150); `inputColor`=rgba(1,0.8,0.6,1); `inputRadius`=50 [0…] {0…300}; `inputCrossScale`=15 [0…] {0…100}; `inputCrossAngle`=0.6 {-π…π}; `inputCrossOpacity`=-2 [-8…] {-8…0}; `inputCrossWidth`=2.5 [0…] {0.5…10}; `inputEpsilon`=-2 [-8…] {-8…0} | 6 | cheap |
<!-- END GENERATED:apply-filter -->

**Slow on video:** `droste` (heavy), `torus_lens`, `glass_lozenge`, `dither` (medium), and the three light overlays at 4K. Everything else is cheap.

### 9.4 `stylize`

Card group **Look**. Distances at the 1080p reference (§9.0).

| `preset` | Card title | Implementation (dump ranges) | Intensity → params: 0.25 / **0.5** / 0.8 / 1.0 | Cost | Slow on video |
|---|---|---|---|---|---|
| `comic` | Look · Comic | `CIComicEffect` (no inputs) | mix 50% / **100%** / 100% + contrast 1.18 / + contrast 1.3 | medium | no |
| `posterize` | Look · Poster | `CIColorPosterize.inputLevels` (min 1, slider 2…30, default 6) | 12 / **6** / 4 / 3 levels (our curve: fewer levels = stronger) | cheap | no |
| `pixellate` | Look · Pixelated | `CIPixellate.inputScale` (min 1, slider 1…100, default 8) | 11 / **22** / 35 / 43 px (our curve: 0.04 × short side × i, so blocks read on a phone) | cheap | no |
| `hex_pixellate` | Look · Hexagons | `CIHexagonalPixellate.inputScale` (min 1, slider 1…100, default 8) | as pixellate | medium | no |
| `crystallize` | Look · Crystallized | `CICrystallize.inputRadius` (min 1, slider 1…100, default 20) | 10 / **20** / 38 / 50 px (our curve, capped at 50 at 1080p for cost) | medium | at ≥ 0.8 |
| `pointillize` | Look · Pointillism | `CIPointillize.inputRadius` (min 1, slider 1…100, default 20) | as crystallize | medium | at ≥ 0.8 |
| `edges` | Look · Edges | `CIEdges.inputIntensity` (min 0, slider 0…10, default 1) | 2.5 / **5** / 8 / 10 (our curve: Apple's default 1 is nearly black) | cheap | no |
| `woodcut` | Look · Woodcut | `CIEdgeWork.inputRadius` (min 0, slider 0…20, default 3) | 1.5 / **3** / 13.2 / 20 (dump curve), composited black on white | medium | no |
| `sketch` | Look · Sketch | `CILineOverlay` (all inputs at dumped defaults, e.g. `inputEdgeIntensity` 1, `inputThreshold` 0.1, `inputContrast` 50) composited over white | mix 50% / **100%** / 100% + contrast 1.18 / + contrast 1.3 | medium | no |
| `thermal` | Look · Thermal | `CIThermal` (no inputs) | mix 50% / **100%** / 100% + contrast | cheap | no |
| `x_ray` | Look · X-ray | `CIXRay` (no inputs) | mix 50% / **100%** / 100% + contrast | cheap | no |
| `glow` | Look · Glow | `CIBloom.inputIntensity` (min 0, slider 0…1, default 0.5), `inputRadius` 10 px ref | 0.25 / **0.5** / 0.8 / 1.0 intensity, radius 10 px (dump default) | medium | no |
| `gloom` | Look · Gloom | `CIGloom.inputIntensity` (same ranges) | 0.25 / **0.5** / 0.8 / 1.0 | medium | no |
| `color_splash` | Look · Only {color} kept | Baked `CIColorCubeWithColorSpace` (33³): hue within ±25° of `color` keeps its saturation, everything else goes to luminance gray | outside-hue saturation 0.5 / **0** / 0 / 0; kept-hue width ±15° / **±25°** / ±35° / ±40° | cheap | no |

Accepted aliases routed elsewhere (not in the enum): `noir`, `chrome`, `fade`, `instant`, `process`, `tonal`, `mono` → `lut`; `sepia` → `apply_color_filter sepia`; `transfer` → `apply_color_filter vintage`.

### 9.5 `blur_sharpen`

Card group **Blur** (Sharpen modes: **Sharpen**; denoise: **Noise**). `S = min(w,h)`.

| `mode` | Card title | Implementation (dump ranges) | Intensity: 0.25 / **0.5** / 0.8 / 1.0 (at 1080p) | Cost | Slow on video |
|---|---|---|---|---|---|
| `blur` | Blur · Soft / Medium / Strong | `CIGaussianBlur.inputRadius` (min 0, slider 0…100, default 10) on `clampedToExtent()` | radius 0.02·S·i: 5.4 / **10.8** / 17.3 / 21.6 px | medium | only at 4K and ≥ 0.8 |
| `motion_blur` | Blur · Motion | `CIMotionBlur.inputRadius` (min 0, slider 0…100, default 20), `inputAngle` from `angle_degrees` | 0.03·S·i: 8 / **16** / 26 / 32 px | medium | no |
| `zoom_blur` | Blur · Zoom | `CIZoomBlur.inputAmount` (slider −200…200, default 20), `inputCenter` from center | 0.03·S·i: 8 / **16** / 26 / 32 | medium | no |
| `lens_blur` | Blur · Lens | `CIBokehBlur.inputRadius` (min/max 0…500, slider 0…100, default 20), other inputs at dumped defaults | 0.02·S·i: 5.4 / **10.8** / 17.3 / 21.6 px | heavy | **yes** |
| `tilt_shift` | Blur · Miniature | `CIMaskedVariableBlur` (`inputRadius` min 0, slider 0…10, default 5) with a `CISmoothLinearGradient` mask: sharp band 30% of height at `center_y`; plus saturation 1.2 | radius 2.5 / **5** / 8 / 10 (dump curve; `inputRadius` is typed Scalar, but scale it by S/1080 like a distance and tune on device) | heavy | **yes** |
| `sharpen` | Sharpen · Light / Medium / Strong | `CISharpenLuminance.inputSharpness` (slider 0…2, default 0.4, identity 0); radius at dumped default 1.69 | 0.5 / **1.0** / 1.6 / 2.0 (our curve 2·i; Apple's 0.4 is hard to see on a phone) | medium | no |
| `denoise` | Noise · Reduced | `CINoiseReduction.inputNoiseLevel` (min 0, slider 0…0.1, default 0.02), `inputSharpness` default 0.4 | 0.025 / **0.05** / 0.08 / 0.1 (our curve 0.1·i) | medium | no |

`radius_px` overrides the intensity radius (1080p reference, clamp 0…100 after scaling for Gaussian/motion/zoom, 0…500 for lens).

### 9.6 `lut`

Card group **Look** (`Look · {name}`). Intensity is a mix (§9.0 "mix presets": 0.25 = 50%, **0.5 = 100%**, above 0.5 adds contrast).

| `preset` | Card title | Implementation | Min iOS | Cost |
|---|---|---|---|---|
| `noir` | Look · Noir | `CIPhotoEffectNoir` (dump: `inputExtrapolate` only) | 7 (dump) | cheap |
| `chrome` | Look · Chrome | `CIPhotoEffectChrome` | 7 | cheap |
| `fade` | Look · Faded | `CIPhotoEffectFade` | 7 | cheap |
| `instant` | Look · Instant | `CIPhotoEffectInstant` | 7 | cheap |
| `mono` | Look · Mono | `CIPhotoEffectMono` | 7 | cheap |
| `process` | Look · Cross-process | `CIPhotoEffectProcess` | 7 | cheap |
| `tonal` | Look · Tonal | `CIPhotoEffectTonal` | 7 | cheap |
| `cinematic`, `warm_film`, `cool_film`, `bleach_bypass`, `golden_hour`, `moody`, `matte`, `vivid`, `pastel` | Look · Cinematic / Warm film / Cool film / Bleach bypass / Golden hour / Moody / Matte / Vivid / Pastel | Baked 33³ `CIColorCubeWithColorSpace` (sRGB) from the recipes in §4.2 | 7 (cube with colour space, dump) | cheap |

Not slow. The `.cube` import path (§4.1) is for later (user-supplied LUTs need a file picker, not a model call).

### 9.7 `vignette_grain`

Card groups **Vignette** and **Grain** ("Vignette · Medium", "Grain · Light", both: "Vignette + grain · Medium").

| `effect` | Implementation (dump ranges) | Intensity: 0.25 / **0.5** / 0.8 / 1.0 | Override |
|---|---|---|---|
| `vignette` | `CIVignetteEffect`: `inputCenter` frame centre, `inputRadius` (min 0, slider 0…2000) = half-diagonal × (1 − 0.5·i), `inputIntensity` (min/max −1…1) = min(1, 0.4 + 1.2·i), `inputFalloff` (0…1, default 0.5) | radius 0.875 / **0.75** / 0.6 / 0.5 × half-diagonal; intensity 0.7 / **1.0** / 1 / 1 (our curve) | `vignette_amount` −1…1 → `inputIntensity` |
| `light_vignette` | Same with negative `inputIntensity` (white corners) | same magnitudes, negated | |
| `grain` | `CIRandomGenerator` (no inputs; static noise) → `CIColorMatrix` to gray noise centred at 0.5 → scaled by S/1080 × 1.5 → added with amplitude `a` via `CIAdditionCompositing` after centring. **Video: translate the noise by a per-frame random offset (seeded by frame index) so the grain moves**; static grain looks like a dirty lens | a = 0.12·i: 0.03 / **0.06** / 0.096 / 0.12 (our curve) | `grain_amount` 0…1 → a = 0.12 × value |
| `vignette_and_grain` | both, vignette first | both curves | both |

Cost cheap. Not slow.

### 9.8 `segment`

Card groups **Background** and **Faces**. Vision details in §5. **Slow on video: yes, every action** (Design §8a progress bar).

| `action` | Card title | Implementation | Intensity: 0.25 / **0.5** / 0.8 / 1.0 |
|---|---|---|---|
| `blur_background` | Background · Blurred | Person mask (§5.1) → sharp subject over `CIGaussianBlur`-ed frame | radius 0.04·S·i: 10.8 / **21.6** / 34.6 / 43.2 px at 1080p (our curve), clamp ≤ 100 |
| `replace_background` | Background · Replaced | Subject over a solid `background_color` (default white) | edge feather only; intensity ignored |
| `remove_background` | Background · Removed | Photo: subject on transparent, export forced to PNG (HEIC keeps alpha too). Video: solid `background_color`, default black | ignored |
| `color_pop` | Background · Black and white | Background saturation → 0 via `CIColorControls` (min 0) | background saturation 0.5 / **0** / 0 / 0, background contrast +0 / **+0** / +0.1 / +0.2 |
| `darken_background` | Background · Darkened | `CIExposureAdjust` on the background only | −0.5 / **−1.0** / −1.6 / −2.0 EV (our curve) |
| `blur_faces` | Faces · Blurred | §5.2 face boxes → elliptical mask → `CIGaussianBlur` | radius 0.03·S·i with a floor of 12 px at 1080p so faces are never recognizable |
| `pixelate_faces` | Faces · Pixelated | same mask → `CIPixellate` | block 0.02·S, floor 16 px at 1080p |

`subject: "any"` uses `VNGenerateForegroundInstanceMaskRequest` (iOS 17) on photos; on video it returns `unsupported_on_device`. Privacy actions (`blur_faces`, `pixelate_faces`) ignore intensity below 0.5 so a "slight" face blur still hides the face.

### 9.9 `audio_effect`

Card group **Audio**. **Video only.** Offline render (§6.7). **Slow on video: yes** for clips longer than ~15 s (progress bar while rendering). Ranges from the dump; preset names Apple docs.

| `effect` | Card title | Units and settings | Intensity: 0.25 / **0.5** / 0.8 / 1.0 | Overrides |
|---|---|---|---|---|
| `bass_boost` / `bass_cut` | Audio · Bass boost / Less bass | `AVAudioUnitEQ` Low Shelf at 100 Hz (gain −96…24 dB) | ±3 / **±6** / ±9.6 / ±12 dB | `gain_db`, `frequency_hz` |
| `treble_boost` / `treble_cut` | Audio · Treble boost / Less treble | High Shelf at 5 kHz | ±3 / **±6** / ±9.6 / ±12 dB | same |
| `voice_boost` | Audio · Voice boost | High Pass 80 Hz + Parametric 2.5 kHz, 1 octave (bandwidth 0.05…5) | +2.5 / **+5** / +8 / +10 dB | same |
| `remove_rumble` | Audio · Rumble removed | Butterworth High Pass | 95 / **130** / 172 / 200 Hz | `frequency_hz` |
| `muffle` | Audio · Muffled | Butterworth Low Pass | 3200 / **2000** / 1380 / 1140 Hz (8000/(1+6i)) | `frequency_hz` |
| `telephone` | Audio · Phone call | Butterworth High Pass 300 Hz + Butterworth Low Pass 3400 Hz, mixed with the original | band-limited share 50% / **100%** / 100% / 100% | `mix_percent` |
| `reverb` | Audio · Reverb | `AVAudioUnitReverb` preset from `reverb_preset` (default mediumHall), `wetDryMix` 0…100 (dump default 0.5!) | 30 / **45** / 63 / 75 % | `mix_percent`, `reverb_preset` |
| `echo` | Audio · Echo | `AVAudioUnitDelay` `delayTime` 0.35 s (0.0001…2), `lowPassCutoff` 8000 Hz | feedback 15 / **30** / 48 / 60 %; wet 30 / **40** / 52 / 60 % | `delay_seconds`, `mix_percent` |
| `pitch_up` / `pitch_down` | Audio · Pitch up / Pitch down (deeper) | `AVAudioUnitTimePitch.pitch` (−2400…2400 cents), rate 1 | ±3 / **±6** / ±10 / ±12 semitones (round(12·i)) | `pitch_semitones` −24…24 |
| `robot` | Audio · Robot voice | `AVAudioUnitDistortion` preset speechAlienChatter | wet 50 / **100** / 100 / 100 % (mix curve) | `mix_percent` |
| `radio` | Audio · Radio voice | preset speechRadioTower | as robot | `mix_percent` |
| `distortion` | Audio · Distortion | preset multiDistortedSquared | wet 25 / **50** / 80 / 100 % | `mix_percent` |
| `noise_gate` | Audio · Noise gate | Custom DSP (§6.6): threshold, attack 5 ms, hold 50 ms, release 100 ms, floor −60 dB (our choices) | threshold −52.5 / **−45** / −36 / −30 dBFS (−60 + 30·i) | – |

Several `audio_effect` calls stack in call order (EQ → pitch → distortion → delay → reverb in the render graph regardless of call order, so tails aren't pitched or distorted).

### 9.10 Summary: slow on video (progress bar)

`segment` (all actions), `audio_effect` (clips > ~15 s), `blur_sharpen` `lens_blur` and `tilt_shift`, `apply_filter` `droste`/`torus_lens`/`glass_lozenge`/`dither`, `stylize` `crystallize`/`pointillize` at intensity ≥ 0.8. Everything else is expected to preview in real time (estimate; confirm with Instruments on the oldest supported iPhone).

### 9.11 Machine-readable definitions

Source of truth: [`data/proposed-tools-build11.json`](data/proposed-tools-build11.json) (OpenAI function format like `tools-schema.v1.json`, plus `mediaTypes`, the `apply_color_filter` description override and the retired-name mapping). Embedded copy:

<!-- BEGIN GENERATED:schemas -->
<details><summary>proposed-tools-build11.json</summary>

```json
{
  "schemaVersion": "1",
  "status": "proposal",
  "targetBuild": "first grouped-tool executor build (called build 11 in ON_DEVICE_TOOLS.md)",
  "mediaTypes": {
    "channel_mixer": [
      "video",
      "image"
    ],
    "color_adjust": [
      "video",
      "image"
    ],
    "apply_filter": [
      "video",
      "image"
    ],
    "stylize": [
      "video",
      "image"
    ],
    "blur_sharpen": [
      "video",
      "image"
    ],
    "lut": [
      "video",
      "image"
    ],
    "vignette_grain": [
      "video",
      "image"
    ],
    "segment": [
      "video",
      "image"
    ],
    "audio_effect": [
      "video"
    ]
  },
  "iosOverrides": {
    "apply_color_filter": {
      "description": "Apply a simple colour tint or classic named colour look: red, green, blue, yellow, cyan, magenta tint, sepia, grayscale, black and white (high contrast), invert, warm, cool, vintage. Use for 'apply a red filter', 'make it black and white', 'sepia', 'vintage', 'warm tones'. For film looks (noir, cinematic, fade) use lut; for artistic styles (comic, sketch, pixelate) use stylize; for adjusting warmth or saturation by an amount use color_adjust. Works on videos and photos."
    }
  },
  "retired": {
    "adjust_brightness": {
      "allowlist": {
        "minBuild": 10,
        "maxBuild": 10
      },
      "executorMapsTo": "color_adjust values.brightness = brightness (CIColorControls.inputBrightness, clamp -1..1)"
    },
    "adjust_contrast": {
      "allowlist": {
        "minBuild": 10,
        "maxBuild": 10
      },
      "executorMapsTo": "color_adjust values.contrast = contrast (CIColorControls.inputContrast, build-10 clamp 0..3)"
    },
    "adjust_saturation": {
      "allowlist": {
        "minBuild": 10,
        "maxBuild": 10
      },
      "executorMapsTo": "color_adjust values.saturation = saturation (CIColorControls.inputSaturation, build-10 clamp 0..3)"
    },
    "adjust_hue": {
      "allowlist": {
        "minBuild": 10,
        "maxBuild": 10
      },
      "executorMapsTo": "color_adjust values.hue_degrees = degrees wrapped to -180..180 (CIHueAdjust)"
    }
  },
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "channel_mixer",
        "description": "Change individual RGB colour channels: remove, keep only, swap, invert, or show one channel as gray. Use for requests that name a channel, e.g. 'remove the red channel', 'only keep green', 'swap red and blue', 'invert the blue channel', 'show the red channel in black and white'. Not for tints or looks ('make it red' = apply_color_filter) and not for warmth/saturation (color_adjust). Presets apply fully at the default intensity; use 0.25 for 'partly'. Works on videos and photos. Out-of-range values are clamped.",
        "parameters": {
          "type": "object",
          "properties": {
            "preset": {
              "type": "string",
              "enum": [
                "remove_red",
                "remove_green",
                "remove_blue",
                "isolate_red",
                "isolate_green",
                "isolate_blue",
                "swap_rb",
                "swap_rg",
                "swap_gb",
                "grayscale_by_red",
                "grayscale_by_green",
                "grayscale_by_blue",
                "invert_red",
                "invert_green",
                "invert_blue",
                "custom"
              ],
              "description": "remove_X sets channel X to 0. isolate_X keeps only channel X (the image turns that colour). swap_XY exchanges two channels. grayscale_by_X shows channel X as a gray image. invert_X inverts one channel. custom uses matrix."
            },
            "intensity": {
              "type": "number",
              "minimum": 0,
              "maximum": 1,
              "default": 0.5,
              "description": "Strength from 0 to 1. Use 0.25 for 'a bit' or 'slightly', 0.5 when the user gives no strength (default), 0.8 for 'a lot', 'very' or 'really', 1.0 only for 'maximum'. Explicit values below override it. For this tool 0.5 and above apply the preset fully; 0.25 applies it half-way."
            },
            "matrix": {
              "type": "array",
              "minItems": 4,
              "maxItems": 4,
              "description": "Only with preset 'custom': 4 rows (R, G, B, A output), each [r, g, b, a, bias]. Coefficients are clamped to -2..2, bias to -1..1.",
              "items": {
                "type": "array",
                "minItems": 5,
                "maxItems": 5,
                "items": {
                  "type": "number"
                }
              }
            }
          },
          "required": [
            "preset"
          ]
        }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "color_adjust",
        "description": "Basic colour and light corrections: brighter/darker, contrast, saturation, vibrance, warmer/cooler (white balance), green/magenta tint, shadows, highlights, midtones, hue shift. Use for 'make it warmer', 'a bit brighter', 'more contrast', 'less saturated', 'lift the shadows', 'recover the highlights'. One call can list several changes. For named looks (sepia, black and white, vintage) use apply_color_filter; for film/cinematic looks use lut. Works on videos and photos. Out-of-range values are clamped.",
        "parameters": {
          "type": "object",
          "properties": {
            "adjust": {
              "type": "array",
              "minItems": 1,
              "items": {
                "type": "string",
                "enum": [
                  "brighter",
                  "darker",
                  "more_contrast",
                  "less_contrast",
                  "more_saturation",
                  "less_saturation",
                  "more_vibrance",
                  "less_vibrance",
                  "warmer",
                  "cooler",
                  "greener",
                  "more_magenta",
                  "lift_shadows",
                  "deepen_shadows",
                  "recover_highlights",
                  "brighter_midtones",
                  "darker_midtones",
                  "hue_shift"
                ]
              },
              "description": "What to change, in plain words. 'more vivid' = more_vibrance; 'muted' or 'desaturate' = less_saturation; 'white balance too blue' = warmer."
            },
            "intensity": {
              "type": "number",
              "minimum": 0,
              "maximum": 1,
              "default": 0.5,
              "description": "Strength from 0 to 1. Use 0.25 for 'a bit' or 'slightly', 0.5 when the user gives no strength (default), 0.8 for 'a lot', 'very' or 'really', 1.0 only for 'maximum'. Explicit values below override it."
            },
            "intensity_per_change": {
              "type": "object",
              "additionalProperties": {
                "type": "number",
                "minimum": 0,
                "maximum": 1
              },
              "description": "Optional per-change strength when changes differ, e.g. {\"brighter\": 0.25, \"warmer\": 0.8}. Same scale as intensity."
            },
            "values": {
              "type": "object",
              "description": "Optional exact values (override intensity). Use only when the user gives numbers.",
              "properties": {
                "exposure_ev": {
                  "type": "number",
                  "minimum": -3,
                  "maximum": 3
                },
                "brightness": {
                  "type": "number",
                  "minimum": -1,
                  "maximum": 1
                },
                "contrast": {
                  "type": "number",
                  "minimum": 0.25,
                  "maximum": 4,
                  "description": "1 = unchanged"
                },
                "saturation": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 2,
                  "description": "1 = unchanged, 0 = gray"
                },
                "vibrance": {
                  "type": "number",
                  "minimum": -1,
                  "maximum": 1
                },
                "temperature_shift_k": {
                  "type": "number",
                  "minimum": -4000,
                  "maximum": 4000,
                  "description": "Positive = warmer"
                },
                "tint_shift": {
                  "type": "number",
                  "minimum": -100,
                  "maximum": 100,
                  "description": "Positive = more magenta, negative = greener"
                },
                "hue_degrees": {
                  "type": "number",
                  "minimum": -180,
                  "maximum": 180
                },
                "gamma": {
                  "type": "number",
                  "minimum": 0.25,
                  "maximum": 4,
                  "description": "1 = unchanged, below 1 brightens midtones"
                },
                "shadows": {
                  "type": "number",
                  "minimum": -1,
                  "maximum": 1
                },
                "highlights": {
                  "type": "number",
                  "minimum": 0.3,
                  "maximum": 1,
                  "description": "1 = unchanged, lower recovers highlights"
                }
              }
            }
          },
          "required": [
            "adjust"
          ]
        }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "apply_filter",
        "description": "Special effects that no other tool covers: distortions (twirl, bulge, pinch, vortex, lens), kaleidoscope and mirror tiles, print/halftone screens, one-colour tint with a chosen colour, duotone, two-tone threshold, light overlays (lens flare, sunbeams). Use only when the request names one of these effects. Colour corrections are color_adjust, named colour looks are apply_color_filter, film looks are lut, artistic styles (comic, sketch, pixelate, glow) are stylize, blur/sharpen is blur_sharpen. Works on videos and photos. Out-of-range values are clamped. Some distortions are slow to preview on video.",
        "parameters": {
          "type": "object",
          "properties": {
            "name": {
              "type": "string",
              "enum": [
                "twirl",
                "vortex",
                "bulge",
                "bulge_line",
                "pinch",
                "circle_splash",
                "hole",
                "light_tunnel",
                "torus_lens",
                "glass_lozenge",
                "circular_wrap",
                "droste",
                "kaleidoscope",
                "triangle_kaleidoscope",
                "op_art_tile",
                "mirror_tile_4",
                "rotated_tile_6",
                "mirror_tile_8",
                "mirror_tile_12",
                "dot_screen",
                "line_screen",
                "hatched_screen",
                "circular_screen",
                "cmyk_halftone",
                "monochrome_tint",
                "duotone",
                "white_point",
                "dither",
                "max_component_gray",
                "min_component_gray",
                "threshold",
                "sunbeams",
                "lens_flare",
                "star_shine"
              ],
              "description": "Effect name. 'bulge' also covers 'fisheye'/'bubble'; 'pinch' is the opposite; 'droste' is an infinite spiral; 'monochrome_tint' tints the whole image one colour (use color)."
            },
            "intensity": {
              "type": "number",
              "minimum": 0,
              "maximum": 1,
              "default": 0.5,
              "description": "Strength from 0 to 1. Use 0.25 for 'a bit' or 'slightly', 0.5 when the user gives no strength (default), 0.8 for 'a lot', 'very' or 'really', 1.0 only for 'maximum'. Explicit values below override it."
            },
            "center_x": {
              "type": "number",
              "minimum": 0,
              "maximum": 1,
              "description": "Horizontal centre of the effect as a fraction of the width (0 = left, 1 = right). Default 0.5."
            },
            "center_y": {
              "type": "number",
              "minimum": 0,
              "maximum": 1,
              "description": "Vertical centre as a fraction of the height (0 = top, 1 = bottom). Default 0.5."
            },
            "color": {
              "type": "string",
              "description": "For monochrome_tint, duotone (dark colour), white_point, lens_flare, sunbeams, star_shine. A colour name (red, orange, yellow, green, cyan, blue, purple, pink, white, black, gray) or #RRGGBB."
            },
            "color2": {
              "type": "string",
              "description": "Second (light) colour for duotone. A colour name (red, orange, yellow, green, cyan, blue, purple, pink, white, black, gray) or #RRGGBB."
            },
            "params": {
              "type": "object",
              "description": "Advanced: raw Core Image inputs for this filter (e.g. {\"inputRadius\": 400}). Validated and clamped against the on-device catalog; unknown keys are ignored."
            }
          },
          "required": [
            "name"
          ]
        }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "stylize",
        "description": "Artistic styles that change the picture's structure, not just its colours: comic book, posterize, pixelate, hexagon pixels, crystallize, pointillism (dots), edges, woodcut, pencil sketch, thermal camera, x-ray, glow (dreamy bloom), gloom, colour splash (keep one colour, rest black and white). Use for 'make it look like a comic', 'pixelate it', 'make it look like a sketch', 'thermal vision', 'keep only the reds'. For colour tints and named colour looks (sepia, black and white, vintage) use apply_color_filter; for film looks (noir, chrome, fade, instant, cinematic) use lut. Works on videos and photos. Out-of-range values are clamped.",
        "parameters": {
          "type": "object",
          "properties": {
            "preset": {
              "type": "string",
              "enum": [
                "comic",
                "posterize",
                "pixellate",
                "hex_pixellate",
                "crystallize",
                "pointillize",
                "edges",
                "woodcut",
                "sketch",
                "thermal",
                "x_ray",
                "glow",
                "gloom",
                "color_splash"
              ]
            },
            "intensity": {
              "type": "number",
              "minimum": 0,
              "maximum": 1,
              "default": 0.5,
              "description": "Strength from 0 to 1. Use 0.25 for 'a bit' or 'slightly', 0.5 when the user gives no strength (default), 0.8 for 'a lot', 'very' or 'really', 1.0 only for 'maximum'. Explicit values below override it."
            },
            "color": {
              "type": "string",
              "description": "Only for color_splash: the colour to keep (default red). A colour name (red, orange, yellow, green, cyan, blue, purple, pink, white, black, gray) or #RRGGBB."
            }
          },
          "required": [
            "preset"
          ]
        }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "blur_sharpen",
        "description": "Blur, soften, sharpen or denoise the whole frame: gaussian blur, motion blur, zoom blur, lens (bokeh) blur, tilt-shift miniature, sharpen, reduce noise/grain. Use for 'blur it', 'soften a bit', 'make it sharper', 'motion blur', 'miniature effect', 'remove noise'. To blur only the background behind a person use segment. Works on videos and photos. Out-of-range values are clamped. Lens blur and tilt-shift are slow to preview on video.",
        "parameters": {
          "type": "object",
          "properties": {
            "mode": {
              "type": "string",
              "enum": [
                "blur",
                "motion_blur",
                "zoom_blur",
                "lens_blur",
                "tilt_shift",
                "sharpen",
                "denoise"
              ]
            },
            "intensity": {
              "type": "number",
              "minimum": 0,
              "maximum": 1,
              "default": 0.5,
              "description": "Strength from 0 to 1. Use 0.25 for 'a bit' or 'slightly', 0.5 when the user gives no strength (default), 0.8 for 'a lot', 'very' or 'really', 1.0 only for 'maximum'. Explicit values below override it."
            },
            "angle_degrees": {
              "type": "number",
              "minimum": -180,
              "maximum": 180,
              "description": "motion_blur direction, 0 = horizontal. Default 0."
            },
            "center_x": {
              "type": "number",
              "minimum": 0,
              "maximum": 1,
              "description": "Horizontal centre of the effect as a fraction of the width (0 = left, 1 = right). Default 0.5."
            },
            "center_y": {
              "type": "number",
              "minimum": 0,
              "maximum": 1,
              "description": "Vertical centre as a fraction of the height (0 = top, 1 = bottom). Default 0.5."
            },
            "radius_px": {
              "type": "number",
              "minimum": 0,
              "maximum": 100,
              "description": "Exact blur radius in pixels at 1080p (scaled to the frame). Overrides intensity."
            }
          },
          "required": [
            "mode"
          ]
        }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "lut",
        "description": "Apply a named photo or film look (colour grade): noir, chrome, fade, instant (Polaroid), mono, process (cross-process), tonal, cinematic (teal and orange), warm film, cool film, bleach bypass, golden hour, moody, matte, vivid, pastel. Use for 'make it cinematic', 'film look', 'noir', 'moody', 'golden hour look'. Plain 'black and white', 'grayscale', 'sepia', 'vintage', 'warm' or 'cool' tints are apply_color_filter, not this tool. Works on videos and photos. Out-of-range values are clamped.",
        "parameters": {
          "type": "object",
          "properties": {
            "preset": {
              "type": "string",
              "enum": [
                "noir",
                "chrome",
                "fade",
                "instant",
                "mono",
                "process",
                "tonal",
                "cinematic",
                "warm_film",
                "cool_film",
                "bleach_bypass",
                "golden_hour",
                "moody",
                "matte",
                "vivid",
                "pastel"
              ]
            },
            "intensity": {
              "type": "number",
              "minimum": 0,
              "maximum": 1,
              "default": 0.5,
              "description": "Strength from 0 to 1. Use 0.25 for 'a bit' or 'slightly', 0.5 when the user gives no strength (default), 0.8 for 'a lot', 'very' or 'really', 1.0 only for 'maximum'. Explicit values below override it."
            }
          },
          "required": [
            "preset"
          ]
        }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "vignette_grain",
        "description": "Darken the corners (vignette) and/or add film grain. Use for 'add a vignette', 'darker edges', 'add grain', 'film grain', 'make it look like film' (both). Works on videos and photos. Out-of-range values are clamped.",
        "parameters": {
          "type": "object",
          "properties": {
            "effect": {
              "type": "string",
              "enum": [
                "vignette",
                "grain",
                "vignette_and_grain",
                "light_vignette"
              ],
              "description": "light_vignette brightens the corners instead of darkening them."
            },
            "intensity": {
              "type": "number",
              "minimum": 0,
              "maximum": 1,
              "default": 0.5,
              "description": "Strength from 0 to 1. Use 0.25 for 'a bit' or 'slightly', 0.5 when the user gives no strength (default), 0.8 for 'a lot', 'very' or 'really', 1.0 only for 'maximum'. Explicit values below override it."
            },
            "vignette_amount": {
              "type": "number",
              "minimum": -1,
              "maximum": 1,
              "description": "Exact vignette strength (negative = light). Overrides intensity."
            },
            "grain_amount": {
              "type": "number",
              "minimum": 0,
              "maximum": 1,
              "description": "Exact grain strength. Overrides intensity."
            }
          },
          "required": [
            "effect"
          ]
        }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "segment",
        "description": "Edit the background behind people, or hide faces, using on-device person detection: blur the background (portrait look), replace it with a colour, remove it, make the background black and white while the person stays in colour, darken the background, blur or pixelate faces. Use for 'blur the background', 'remove the background', 'make the background white', 'keep me in colour', 'blur faces'. Works on videos and photos; on video it is slow to preview and background removal becomes a solid colour (videos have no transparency). subject 'any' (pets, objects) is photos only. Out-of-range values are clamped.",
        "parameters": {
          "type": "object",
          "properties": {
            "action": {
              "type": "string",
              "enum": [
                "blur_background",
                "replace_background",
                "remove_background",
                "color_pop",
                "darken_background",
                "blur_faces",
                "pixelate_faces"
              ],
              "description": "color_pop = person in colour, background black and white."
            },
            "subject": {
              "type": "string",
              "enum": [
                "person",
                "any"
              ],
              "default": "person",
              "description": "any = most prominent subject (pets, objects); photos only."
            },
            "background_color": {
              "type": "string",
              "description": "For replace_background (default white) and remove_background on video (default black). A colour name (red, orange, yellow, green, cyan, blue, purple, pink, white, black, gray) or #RRGGBB."
            },
            "intensity": {
              "type": "number",
              "minimum": 0,
              "maximum": 1,
              "default": 0.5,
              "description": "Strength from 0 to 1. Use 0.25 for 'a bit' or 'slightly', 0.5 when the user gives no strength (default), 0.8 for 'a lot', 'very' or 'really', 1.0 only for 'maximum'. Explicit values below override it."
            }
          },
          "required": [
            "action"
          ]
        }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "audio_effect",
        "description": "Audio effects rendered on the device: bass or treble boost/cut, voice boost (clearer speech), remove low rumble, muffle, telephone, reverb, echo, pitch up/down, robot voice, radio voice, distortion, noise gate (silence background hiss between words). Use for 'add reverb', 'more bass', 'make my voice deeper', 'chipmunk voice', 'sound like a phone call', 'remove the hum'. Videos only (not photos). Volume and fades are adjust_audio_volume and audio_fade. Out-of-range values are clamped. Rendering takes a few seconds on long clips.",
        "parameters": {
          "type": "object",
          "properties": {
            "effect": {
              "type": "string",
              "enum": [
                "bass_boost",
                "bass_cut",
                "treble_boost",
                "treble_cut",
                "voice_boost",
                "remove_rumble",
                "muffle",
                "telephone",
                "reverb",
                "echo",
                "pitch_up",
                "pitch_down",
                "robot",
                "radio",
                "distortion",
                "noise_gate"
              ],
              "description": "'deeper voice' = pitch_down; 'chipmunk' = pitch_up with intensity 0.8; 'hum'/'rumble' = remove_rumble; 'hiss between words' = noise_gate."
            },
            "intensity": {
              "type": "number",
              "minimum": 0,
              "maximum": 1,
              "default": 0.5,
              "description": "Strength from 0 to 1. Use 0.25 for 'a bit' or 'slightly', 0.5 when the user gives no strength (default), 0.8 for 'a lot', 'very' or 'really', 1.0 only for 'maximum'. Explicit values below override it."
            },
            "reverb_preset": {
              "type": "string",
              "enum": [
                "small_room",
                "medium_room",
                "large_room",
                "medium_hall",
                "large_hall",
                "plate",
                "medium_chamber",
                "large_chamber",
                "cathedral"
              ],
              "description": "Room type for reverb. Default medium_hall ('church' = cathedral, 'bathroom' = small_room)."
            },
            "pitch_semitones": {
              "type": "number",
              "minimum": -24,
              "maximum": 24,
              "description": "Exact pitch shift for pitch_up/pitch_down (12 = one octave). Overrides intensity."
            },
            "delay_seconds": {
              "type": "number",
              "minimum": 0.02,
              "maximum": 2,
              "description": "Echo delay. Default 0.35."
            },
            "mix_percent": {
              "type": "number",
              "minimum": 0,
              "maximum": 100,
              "description": "Exact wet/dry mix for reverb, echo, distortion, robot, radio. Overrides intensity."
            },
            "gain_db": {
              "type": "number",
              "minimum": -24,
              "maximum": 24,
              "description": "Exact EQ gain for bass/treble/voice effects. Overrides intensity."
            },
            "frequency_hz": {
              "type": "number",
              "minimum": 20,
              "maximum": 20000,
              "description": "Exact cutoff/centre frequency for EQ effects."
            }
          },
          "required": [
            "effect"
          ]
        }
      }
    }
  ]
}
```

</details>
<!-- END GENERATED:schemas -->

## 10. Gaps and caveats

- Cost classes are estimates (the simulator bench was meaningless, §0). Profile `segment`, `lens_blur`, `tilt_shift`, `crystallize` and the heavy distortions on the oldest supported iPhone before finalizing the "slow" flags.
- Vision and `CIPersonSegmentation` were only checked for existence in the simulator, not run.
- `CITemperatureAndTint` has no dumped ranges; the warm/cool and tint directions need a device check (§9.2).
- Apple's defaults for positions and radii assume small images; all distance values are scaled from a 1080p reference (§9.0). Visual tuning of the "our curve" rows is still needed on a real phone.
- Preset names for `AVAudioUnitReverb` / `AVAudioUnitDistortion` and the Vision min-iOS column come from Apple docs, not the dump.
- The iOS 17 runtime came from `xcodebuild -downloadPlatform` on `macos-15` (no image ships it); if Apple pulls 17.5 downloads, the workflow input `ios17_version` can pick another 17.x.
- iOS 26.x newest on GitHub runners is 26.5 (macos-26 image, Xcode 26.6).
