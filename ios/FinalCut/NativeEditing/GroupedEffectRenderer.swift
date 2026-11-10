import CoreImage
import Foundation
import UIKit
import Vision

/// Core Image (and Vision) implementation of the eight visual grouped tools.
/// Recipes and intensity curves follow docs/ios/ON_DEVICE_TOOLS.md §3–5 and §9.
enum GroupedEffectRenderer {
    static let context = CIContext(options: [.cacheIntermediates: false])

    static func apply(_ op: NativeOp, to image: CIImage, size: CGSize, time: Double, session: SegmentSession?) -> CIImage {
        switch op {
        case .channelMixer(let o): return channelMixer(o, to: image)
        case .colorAdjust(let o): return colorAdjust(o, to: image)
        case .applyFilter(let o): return applyFilter(o, to: image, size: size)
        case .stylize(let o): return stylize(o, to: image, size: size)
        case .blurSharpen(let o): return blurSharpen(o, to: image, size: size)
        case .lut(let o): return lut(o, to: image)
        case .vignetteGrain(let o): return vignetteGrain(o, to: image, size: size, time: time)
        case .segment(let o): return segment(o, to: image, size: size, time: time, session: session)
        default: return image
        }
    }

    // MARK: - Mix / colour helpers

    static func mix(_ effect: CIImage, over original: CIImage, amount: Double, extraContrast contrast: Double = 1) -> CIImage {
        let amount = GroupedIntensity.clamp01(amount)
        if amount <= 0 { return original }
        var top = effect
        if contrast != 1 {
            top = top.applyingFilter("CIColorControls", parameters: [kCIInputContrastKey: contrast])
        }
        if amount >= 1 { return top }
        return FrameRenderer.blend(top, over: original, amount: amount)
    }

    static func ciColor(_ name: String?, fallback: RGBAColor) -> CIColor {
        let parsed = name.flatMap(RGBAColor.parse) ?? fallback
        return CIColor(red: parsed.r, green: parsed.g, blue: parsed.b, alpha: parsed.a)
    }

    static func ciPoint(x: Double?, y: Double?, size: CGSize, defaultX: Double = 0.5, defaultY: Double = 0.5) -> CIVector {
        let nx = x ?? defaultX
        let ny = y ?? defaultY
        return CIVector(x: nx * size.width, y: (1 - ny) * size.height)
    }

    static func shortSide(_ size: CGSize) -> CGFloat { min(size.width, size.height) }

    static func refScale(_ size: CGSize) -> CGFloat { shortSide(size) / 1080 }

    // MARK: - channel_mixer

    /// Preset 4×5 matrices (R,G,B,A rows; last column is bias). Identity is I.
    static func channelMatrix(_ preset: String) -> [[Double]]? {
        let I: [[Double]] = [
            [1, 0, 0, 0, 0],
            [0, 1, 0, 0, 0],
            [0, 0, 1, 0, 0],
            [0, 0, 0, 1, 0],
        ]
        func zero(_ row: Int) -> [[Double]] { var m = I; m[row] = [0, 0, 0, 0, 0]; return m }
        switch preset {
        case "remove_red": return zero(0)
        case "remove_green": return zero(1)
        case "remove_blue": return zero(2)
        case "isolate_red": return [I[0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], I[3]]
        case "isolate_green": return [[0, 0, 0, 0, 0], I[1], [0, 0, 0, 0, 0], I[3]]
        case "isolate_blue": return [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], I[2], I[3]]
        case "swap_rb": return [[0, 0, 1, 0, 0], I[1], [1, 0, 0, 0, 0], I[3]]
        case "swap_rg": return [[0, 1, 0, 0, 0], [1, 0, 0, 0, 0], I[2], I[3]]
        case "swap_gb": return [I[0], [0, 0, 1, 0, 0], [0, 1, 0, 0, 0], I[3]]
        case "grayscale_by_red": return [[1, 0, 0, 0, 0], [1, 0, 0, 0, 0], [1, 0, 0, 0, 0], I[3]]
        case "grayscale_by_green": return [[0, 1, 0, 0, 0], [0, 1, 0, 0, 0], [0, 1, 0, 0, 0], I[3]]
        case "grayscale_by_blue": return [[0, 0, 1, 0, 0], [0, 0, 1, 0, 0], [0, 0, 1, 0, 0], I[3]]
        case "invert_red": return [[-1, 0, 0, 0, 1], I[1], I[2], I[3]]
        case "invert_green": return [I[0], [0, -1, 0, 0, 1], I[2], I[3]]
        case "invert_blue": return [I[0], I[1], [0, 0, -1, 0, 1], I[3]]
        default: return nil
        }
    }

    static func channelMixer(_ op: ChannelMixerOp, to image: CIImage) -> CIImage {
        let preset: [[Double]]
        if op.preset == "custom", let m = op.matrix, m.count == 4, m.allSatisfy({ $0.count == 5 }) {
            preset = m
        } else if let m = channelMatrix(op.preset) {
            preset = m
        } else {
            return image
        }
        let k = GroupedIntensity.mixAmount(op.intensity)
        let I: [[Double]] = [
            [1, 0, 0, 0, 0],
            [0, 1, 0, 0, 0],
            [0, 0, 1, 0, 0],
            [0, 0, 0, 1, 0],
        ]
        let mixed = zip(I, preset).map { ir, pr in zip(ir, pr).map { $0 + k * ($1 - $0) } }
        let vec = { (row: [Double]) in CIVector(x: row[0], y: row[1], z: row[2], w: row[3]) }
        let out = image.applyingFilter("CIColorMatrix", parameters: [
            "inputRVector": vec(mixed[0]),
            "inputGVector": vec(mixed[1]),
            "inputBVector": vec(mixed[2]),
            "inputAVector": vec(mixed[3]),
            "inputBiasVector": CIVector(x: mixed[0][4], y: mixed[1][4], z: mixed[2][4], w: mixed[3][4]),
        ])
        return out.applyingFilter("CIColorClamp", parameters: [
            "inputMinComponents": CIVector(x: 0, y: 0, z: 0, w: 0),
            "inputMaxComponents": CIVector(x: 1, y: 1, z: 1, w: 1),
        ])
    }

    // MARK: - color_adjust

    static func colorAdjust(_ op: ColorAdjustOp, to image: CIImage) -> CIImage {
        func i(_ name: String) -> Double {
            op.intensityPerChange[name] ?? op.intensity
        }
        var exposure = 0.0
        var contrast = 1.0
        var saturation = 1.0
        var brightness = 0.0
        var vibrance = 0.0
        var temp = 0.0
        var tint = 0.0
        var shadows = 0.0
        var highlights = 1.0
        var gamma: Double?
        var hue = 0.0
        var hasTemp = false
        var hasShadows = false
        var hasVibrance = false
        var hasHue = false

        for name in op.adjust {
            let t = i(name)
            switch name {
            case "brighter": exposure += GroupedIntensity.curve(t, from: 0, mid: 0.75, to: 1.5)
            case "darker": exposure -= GroupedIntensity.curve(t, from: 0, mid: 0.75, to: 1.5)
            case "more_contrast": contrast *= GroupedIntensity.curve(t, from: 1, mid: 1.3, to: 1.6)
            case "less_contrast": contrast *= GroupedIntensity.curve(t, from: 1, mid: 0.7, to: 0.4)
            case "more_saturation": saturation *= GroupedIntensity.curve(t, from: 1, mid: 1.5, to: 2)
            case "less_saturation": saturation *= GroupedIntensity.curve(t, from: 1, mid: 0.5, to: 0)
            case "more_vibrance": vibrance += GroupedIntensity.curve(t, from: 0, mid: 0.5, to: 1); hasVibrance = true
            case "less_vibrance": vibrance -= GroupedIntensity.curve(t, from: 0, mid: 0.5, to: 1); hasVibrance = true
            case "warmer": temp += GroupedIntensity.curve(t, from: 0, mid: 2000, to: 4000); hasTemp = true
            case "cooler": temp -= GroupedIntensity.curve(t, from: 0, mid: 2000, to: 4000); hasTemp = true
            case "more_magenta": tint += GroupedIntensity.curve(t, from: 0, mid: 50, to: 100); hasTemp = true
            case "greener": tint -= GroupedIntensity.curve(t, from: 0, mid: 50, to: 100); hasTemp = true
            case "lift_shadows": shadows += GroupedIntensity.curve(t, from: 0, mid: 0.5, to: 1); hasShadows = true
            case "deepen_shadows": shadows -= GroupedIntensity.curve(t, from: 0, mid: 0.5, to: 1); hasShadows = true
            case "recover_highlights":
                highlights *= GroupedIntensity.curve(t, from: 1, mid: 0.65, to: 0.3)
                hasShadows = true
            case "brighter_midtones":
                let g = 1 / (1 + GroupedIntensity.clamp01(t))
                gamma = (gamma ?? 1) * g
            case "darker_midtones":
                let g = 1 + GroupedIntensity.clamp01(t)
                gamma = (gamma ?? 1) * g
            case "hue_shift": hue += 180 * GroupedIntensity.clamp01(t); hasHue = true
            default: break
            }
        }

        let v = op.values
        if let x = v.exposureEV { exposure = x }
        if let x = v.brightness { brightness = x }
        if let x = v.contrast { contrast = x }
        if let x = v.saturation { saturation = x }
        if let x = v.vibrance { vibrance = x; hasVibrance = true }
        if let x = v.temperatureShiftK { temp = x; hasTemp = true }
        if let x = v.tintShift { tint = x; hasTemp = true }
        if let x = v.hueDegrees { hue = x; hasHue = true }
        if let x = v.gamma { gamma = x }
        if let x = v.shadows { shadows = x; hasShadows = true }
        if let x = v.highlights { highlights = x; hasShadows = true }

        exposure = GroupedIntensity.clamp(exposure, -3, 3)
        contrast = GroupedIntensity.clamp(contrast, 0.25, 4)
        saturation = GroupedIntensity.clamp(saturation, 0, 2)
        brightness = GroupedIntensity.clamp(brightness, -1, 1)
        vibrance = GroupedIntensity.clamp(vibrance, -1, 1)
        temp = GroupedIntensity.clamp(temp, -4000, 4000)
        tint = GroupedIntensity.clamp(tint, -100, 100)
        shadows = GroupedIntensity.clamp(shadows, -1, 1)
        highlights = GroupedIntensity.clamp(highlights, 0.3, 1)
        hue = GroupedIntensity.clamp(hue, -180, 180)
        if let g = gamma { gamma = GroupedIntensity.clamp(g, 0.25, 4) }

        var out = image
        if exposure != 0 {
            out = out.applyingFilter("CIExposureAdjust", parameters: [kCIInputEVKey: exposure])
        }
        if hasTemp {
            out = out.applyingFilter("CITemperatureAndTint", parameters: [
                "inputNeutral": CIVector(x: 6500 + temp, y: tint),
                "inputTargetNeutral": CIVector(x: 6500, y: 0),
            ])
        }
        if hasShadows {
            out = out.applyingFilter("CIHighlightShadowAdjust", parameters: [
                "inputShadowAmount": shadows,
                "inputHighlightAmount": highlights,
            ])
        }
        if let g = gamma, abs(g - 1) > 0.0001 {
            out = out.applyingFilter("CIGammaAdjust", parameters: ["inputPower": g])
        }
        if brightness != 0 || abs(contrast - 1) > 0.0001 || abs(saturation - 1) > 0.0001 {
            out = out.applyingFilter("CIColorControls", parameters: [
                kCIInputBrightnessKey: brightness,
                kCIInputContrastKey: contrast,
                kCIInputSaturationKey: saturation,
            ])
        }
        if hasVibrance, vibrance != 0 {
            out = out.applyingFilter("CIVibrance", parameters: ["inputAmount": vibrance])
        }
        if hasHue, hue != 0 {
            out = out.applyingFilter("CIHueAdjust", parameters: [kCIInputAngleKey: hue * .pi / 180])
        }
        return out
    }

    // MARK: - apply_filter

    static func applyFilter(_ op: ApplyFilterOp, to image: CIImage, size: CGSize) -> CIImage {
        let i = op.intensity
        let center = ciPoint(x: op.centerX, y: op.centerY, size: size)
        let S = shortSide(size)
        let defaultRadius = 0.35 * S
        let scale = refScale(size)

        func dist(_ pxAt1080: Double) -> Double { pxAt1080 * Double(scale) }

        func raw(_ key: String) -> Double? {
            op.params[key]?.doubleValue
        }

        func applyCI(_ name: String, _ params: [String: Any]) -> CIImage? {
            var merged = params
            for (k, v) in op.params {
                if merged[k] != nil { continue }
                if let d = v.doubleValue { merged[k] = d }
            }
            guard let filter = CIFilter(name: name) else { return nil }
            filter.setValue(image, forKey: kCIInputImageKey)
            for (k, v) in merged {
                filter.setValue(v, forKey: k)
            }
            return filter.outputImage?.cropped(to: image.extent)
        }

        let radius = raw("inputRadius").map { dist($0) } ?? Double(defaultRadius)

        switch op.name {
        case "twirl":
            let angle = raw("inputAngle") ?? GroupedIntensity.lerp(i, 0, 1.571, 3.142, 8.796, 12.57)
            return applyCI("CITwirlDistortion", [kCIInputCenterKey: center, kCIInputRadiusKey: raw("inputRadius").map(dist) ?? Double(defaultRadius), kCIInputAngleKey: angle]) ?? image
        case "vortex":
            let angle = raw("inputAngle") ?? GroupedIntensity.lerp(i, 0, 28.27, 56.55, 79.17, 94.25)
            return applyCI("CIVortexDistortion", [kCIInputCenterKey: center, kCIInputRadiusKey: raw("inputRadius").map(dist) ?? Double(defaultRadius), kCIInputAngleKey: angle]) ?? image
        case "bulge":
            let s = raw("inputScale") ?? GroupedIntensity.lerp(i, 0, 0.25, 0.5, 0.8, 1)
            return applyCI("CIBumpDistortion", [kCIInputCenterKey: center, kCIInputRadiusKey: radius, kCIInputScaleKey: s]) ?? image
        case "bulge_line":
            let s = raw("inputScale") ?? GroupedIntensity.lerp(i, 0, 0.25, 0.5, 0.8, 1)
            return applyCI("CIBumpDistortionLinear", [kCIInputCenterKey: center, kCIInputRadiusKey: radius, kCIInputScaleKey: s, kCIInputAngleKey: raw("inputAngle") ?? 0]) ?? image
        case "pinch":
            let s = raw("inputScale") ?? GroupedIntensity.lerp(i, 0, 0.25, 0.5, 1.4, 2)
            return applyCI("CIPinchDistortion", [kCIInputCenterKey: center, kCIInputRadiusKey: radius, kCIInputScaleKey: s]) ?? image
        case "circle_splash":
            let r = raw("inputRadius").map(dist) ?? dist(GroupedIntensity.lerp(i, 0, 75, 150, 660, 1000))
            return applyCI("CICircleSplashDistortion", [kCIInputCenterKey: center, kCIInputRadiusKey: r]) ?? image
        case "hole":
            let r = raw("inputRadius").map(dist) ?? dist(GroupedIntensity.lerp(i, 0.1, 75.05, 150, 660, 1000))
            return applyCI("CIHoleDistortion", [kCIInputCenterKey: center, kCIInputRadiusKey: max(0.1, r)]) ?? image
        case "light_tunnel":
            let rot = raw("inputRotation") ?? GroupedIntensity.lerp(i, 0, 0.3927, 0.7854, 1.257, 1.571)
            return applyCI("CILightTunnel", [kCIInputCenterKey: center, kCIInputRadiusKey: raw("inputRadius").map(dist) ?? dist(100), "inputRotation": rot]) ?? image
        case "torus_lens":
            let ref = raw("inputRefraction") ?? GroupedIntensity.lerp(i, 1, 1.35, 1.7, 3.68, 5)
            return applyCI("CITorusLensDistortion", [kCIInputCenterKey: center, kCIInputRadiusKey: raw("inputRadius").map(dist) ?? dist(160), "inputWidth": raw("inputWidth").map(dist) ?? dist(80), "inputRefraction": ref]) ?? image
        case "glass_lozenge":
            let ref = raw("inputRefraction") ?? GroupedIntensity.lerp(i, 1, 1.35, 1.7, 3.68, 5)
            let p0 = CIVector(x: size.width * 0.3, y: size.height * 0.5)
            let p1 = CIVector(x: size.width * 0.7, y: size.height * 0.5)
            return applyCI("CIGlassLozenge", ["inputPoint0": p0, "inputPoint1": p1, kCIInputRadiusKey: raw("inputRadius").map(dist) ?? dist(100), "inputRefraction": ref]) ?? image
        case "circular_wrap":
            let angle = raw("inputAngle") ?? GroupedIntensity.lerp(i, 0, 0.7854, 1.571, 2.513, 3.142)
            return applyCI("CICircularWrap", [kCIInputCenterKey: center, kCIInputRadiusKey: raw("inputRadius").map(dist) ?? dist(150), kCIInputAngleKey: angle]) ?? image
        case "droste":
            let zoom = raw("inputZoom") ?? GroupedIntensity.lerp(i, 0.01, 0.505, 1, 3.4, 5)
            let inset0 = CIVector(x: size.width * 0.25, y: size.height * 0.25)
            let inset1 = CIVector(x: size.width * 0.75, y: size.height * 0.75)
            return applyCI("CIDroste", ["inputInsetPoint0": inset0, "inputInsetPoint1": inset1, "inputStrands": raw("inputStrands") ?? 1, "inputPeriodicity": raw("inputPeriodicity") ?? 1, "inputRotation": raw("inputRotation") ?? 0, "inputZoom": zoom]) ?? image
        case "kaleidoscope":
            let fx = applyCI("CIKaleidoscope", [kCIInputCenterKey: center, "inputCount": raw("inputCount") ?? 6, kCIInputAngleKey: raw("inputAngle") ?? 0]) ?? image
            return mix(fx, over: image, amount: GroupedIntensity.mixAmount(i), extraContrast: GroupedIntensity.extraContrast(i))
        case "triangle_kaleidoscope":
            let fx = applyCI("CITriangleKaleidoscope", ["inputPoint": center, "inputSize": raw("inputSize").map(dist) ?? dist(700), "inputRotation": raw("inputRotation") ?? 5.924, "inputDecay": raw("inputDecay") ?? 0.85]) ?? image
            return mix(fx, over: image, amount: GroupedIntensity.mixAmount(i), extraContrast: GroupedIntensity.extraContrast(i))
        case "op_art_tile":
            let s = raw("inputScale") ?? GroupedIntensity.lerp(i, 1, 1.9, 2.8, 7.12, 10)
            return applyCI("CIOpTile", [kCIInputCenterKey: center, kCIInputScaleKey: s, kCIInputAngleKey: raw("inputAngle") ?? 0, "inputWidth": raw("inputWidth").map(dist) ?? dist(65)]) ?? image
        case "mirror_tile_4":
            let fx = applyCI("CIFourfoldReflectedTile", [kCIInputCenterKey: center, kCIInputAngleKey: raw("inputAngle") ?? 0, "inputWidth": raw("inputWidth").map(dist) ?? dist(100)]) ?? image
            return mix(fx, over: image, amount: GroupedIntensity.mixAmount(i), extraContrast: GroupedIntensity.extraContrast(i))
        case "rotated_tile_6":
            let fx = applyCI("CISixfoldRotatedTile", [kCIInputCenterKey: center, kCIInputAngleKey: raw("inputAngle") ?? 0, "inputWidth": raw("inputWidth").map(dist) ?? dist(100)]) ?? image
            return mix(fx, over: image, amount: GroupedIntensity.mixAmount(i), extraContrast: GroupedIntensity.extraContrast(i))
        case "mirror_tile_8":
            let fx = applyCI("CIEightfoldReflectedTile", [kCIInputCenterKey: center, kCIInputAngleKey: raw("inputAngle") ?? 0, "inputWidth": raw("inputWidth").map(dist) ?? dist(100)]) ?? image
            return mix(fx, over: image, amount: GroupedIntensity.mixAmount(i), extraContrast: GroupedIntensity.extraContrast(i))
        case "mirror_tile_12":
            let fx = applyCI("CITwelvefoldReflectedTile", [kCIInputCenterKey: center, kCIInputAngleKey: raw("inputAngle") ?? 0, "inputWidth": raw("inputWidth").map(dist) ?? dist(100)]) ?? image
            return mix(fx, over: image, amount: GroupedIntensity.mixAmount(i), extraContrast: GroupedIntensity.extraContrast(i))
        case "dot_screen", "line_screen", "hatched_screen", "circular_screen", "cmyk_halftone":
            let filterName: String = [
                "dot_screen": "CIDotScreen", "line_screen": "CILineScreen", "hatched_screen": "CIHatchedScreen",
                "circular_screen": "CICircularScreen", "cmyk_halftone": "CICMYKHalftone",
            ][op.name]!
            let p100 = op.name == "cmyk_halftone" ? 100.0 : 50.0
            let width = raw("inputWidth").map(dist) ?? dist(GroupedIntensity.lerp(i, 2, 7, 12, op.name == "cmyk_halftone" ? 64.8 : 34.8, p100))
            var params: [String: Any] = [kCIInputCenterKey: center, "inputWidth": max(1, width), "inputSharpness": raw("inputSharpness") ?? 0.7]
            if op.name != "circular_screen" { params[kCIInputAngleKey] = raw("inputAngle") ?? 0 }
            if op.name == "cmyk_halftone" {
                params["inputGCR"] = raw("inputGCR") ?? 1
                params["inputUCR"] = raw("inputUCR") ?? 0.5
            }
            return applyCI(filterName, params) ?? image
        case "monochrome_tint":
            let intensity = raw("inputIntensity") ?? GroupedIntensity.mixAmount(i)
            return applyCI("CIColorMonochrome", [
                kCIInputColorKey: ciColor(op.color, fallback: RGBAColor(r: 0.6, g: 0.45, b: 0.3, a: 1)),
                kCIInputIntensityKey: intensity,
            ]) ?? image
        case "duotone":
            let fx = applyCI("CIFalseColor", [
                "inputColor0": ciColor(op.color, fallback: RGBAColor(r: 0.3, g: 0, b: 0, a: 1)),
                "inputColor1": ciColor(op.color2, fallback: RGBAColor(r: 1, g: 0.9, b: 0.8, a: 1)),
            ]) ?? image
            return mix(fx, over: image, amount: GroupedIntensity.mixAmount(i), extraContrast: GroupedIntensity.extraContrast(i))
        case "white_point":
            let fx = applyCI("CIWhitePointAdjust", [kCIInputColorKey: ciColor(op.color, fallback: .white)]) ?? image
            return mix(fx, over: image, amount: GroupedIntensity.mixAmount(i), extraContrast: GroupedIntensity.extraContrast(i))
        case "dither":
            let intensity = raw("inputIntensity") ?? GroupedIntensity.lerp(i, 0, 0.05, 0.1, 0.64, 1)
            return applyCI("CIDither", [kCIInputIntensityKey: intensity]) ?? image
        case "max_component_gray":
            let fx = applyCI("CIMaximumComponent", [:]) ?? image
            return mix(fx, over: image, amount: GroupedIntensity.mixAmount(i), extraContrast: GroupedIntensity.extraContrast(i))
        case "min_component_gray":
            let fx = applyCI("CIMinimumComponent", [:]) ?? image
            return mix(fx, over: image, amount: GroupedIntensity.mixAmount(i), extraContrast: GroupedIntensity.extraContrast(i))
        case "threshold":
            let t = raw("inputThreshold") ?? GroupedIntensity.lerp(i, 0, 0.25, 0.5, 0.8, 1)
            return applyCI("CIColorThreshold", ["inputThreshold": t]) ?? image
        case "sunbeams", "lens_flare", "star_shine":
            return overlayGenerator(op, on: image, size: size, center: center)
        default:
            return image
        }
    }

    static func overlayGenerator(_ op: ApplyFilterOp, on image: CIImage, size: CGSize, center: CIVector) -> CIImage {
        let name: String
        var params: [String: Any] = [kCIInputCenterKey: center]
        switch op.name {
        case "sunbeams":
            name = "CISunbeamsGenerator"
            params[kCIInputColorKey] = ciColor(op.color, fallback: RGBAColor(r: 1, g: 0.5, b: 0, a: 1))
            params["inputSunRadius"] = Double(40 * refScale(size))
            params["inputMaxStriationRadius"] = 2.58
            params["inputStriationStrength"] = 0.5
            params["inputStriationContrast"] = 1.375
            params["inputTime"] = 0
        case "lens_flare":
            name = "CILenticularHaloGenerator"
            params[kCIInputColorKey] = ciColor(op.color, fallback: RGBAColor(r: 1, g: 0.9, b: 0.8, a: 1))
            params["inputHaloRadius"] = Double(70 * refScale(size))
            params["inputHaloWidth"] = Double(87 * refScale(size))
            params["inputHaloOverlap"] = 0.77
            params["inputStriationStrength"] = 0.5
            params["inputStriationContrast"] = 1
            params["inputTime"] = 0
        default:
            name = "CIStarShineGenerator"
            params[kCIInputColorKey] = ciColor(op.color, fallback: RGBAColor(r: 1, g: 0.8, b: 0.6, a: 1))
            params[kCIInputRadiusKey] = Double(50 * refScale(size))
            params["inputCrossScale"] = 15
            params["inputCrossAngle"] = 0.6
            params["inputCrossOpacity"] = -2
            params["inputCrossWidth"] = 2.5
            params["inputEpsilon"] = -2
        }
        for (k, v) in op.params {
            if let d = v.doubleValue { params[k] = d }
        }
        guard let filter = CIFilter(name: name) else { return image }
        for (k, v) in params { filter.setValue(v, forKey: k) }
        guard let overlay = filter.outputImage?.cropped(to: image.extent) else { return image }
        let faded = overlay.applyingFilter("CIColorMatrix", parameters: [
            "inputAVector": CIVector(x: 0, y: 0, z: 0, w: GroupedIntensity.mixAmount(op.intensity)),
        ])
        return faded.applyingFilter("CIScreenBlendMode", parameters: [kCIInputBackgroundImageKey: image])
    }

    // MARK: - stylize

    static func stylize(_ op: StylizeOp, to image: CIImage, size: CGSize) -> CIImage {
        let i = op.intensity
        let S = shortSide(size)
        let scale = refScale(size)
        switch op.preset {
        case "comic":
            let fx = image.applyingFilter("CIComicEffect")
            let contrast = i >= 0.8 ? (i >= 1 ? 1.3 : 1.18) : 1
            return mix(fx, over: image, amount: GroupedIntensity.mixAmount(i), extraContrast: contrast == 1 ? GroupedIntensity.extraContrast(i) : contrast)
        case "posterize":
            let levels = GroupedIntensity.lerp(i, 20, 12, 6, 4, 3)
            return image.applyingFilter("CIColorPosterize", parameters: ["inputLevels": max(2, levels)])
        case "pixellate":
            let s = max(1, 0.04 * S * CGFloat(i))
            return image.applyingFilter("CIPixellate", parameters: [kCIInputCenterKey: ciPoint(x: 0.5, y: 0.5, size: size), kCIInputScaleKey: s])
        case "hex_pixellate":
            let s = max(1, 0.04 * S * CGFloat(i))
            return image.applyingFilter("CIHexagonalPixellate", parameters: [kCIInputCenterKey: ciPoint(x: 0.5, y: 0.5, size: size), kCIInputScaleKey: s])
        case "crystallize":
            let r = min(50 * scale, max(1, GroupedIntensity.lerp(i, 0, 10, 20, 38, 50) * Double(scale)))
            return image.applyingFilter("CICrystallize", parameters: [kCIInputCenterKey: ciPoint(x: 0.5, y: 0.5, size: size), kCIInputRadiusKey: r])
        case "pointillize":
            let r = min(50 * scale, max(1, GroupedIntensity.lerp(i, 0, 10, 20, 38, 50) * Double(scale)))
            return image.applyingFilter("CIPointillize", parameters: [kCIInputCenterKey: ciPoint(x: 0.5, y: 0.5, size: size), kCIInputRadiusKey: r])
        case "edges":
            let intensity = GroupedIntensity.curve(i, from: 0, mid: 5, to: 10)
            return image.applyingFilter("CIEdges", parameters: [kCIInputIntensityKey: intensity])
        case "woodcut":
            let r = GroupedIntensity.lerp(i, 0, 1.5, 3, 13.2, 20)
            let edges = image.applyingFilter("CIEdgeWork", parameters: [kCIInputRadiusKey: r])
            let white = CIImage(color: .white).cropped(to: image.extent)
            return edges.composited(over: white)
        case "sketch":
            let line = image.applyingFilter("CILineOverlay", parameters: [
                "inputNRNoiseLevel": 0.07, "inputNRSharpness": 0.71,
                "inputEdgeIntensity": 1, "inputThreshold": 0.1, "inputContrast": 50,
            ])
            let white = CIImage(color: .white).cropped(to: image.extent)
            let fx = line.composited(over: white)
            let contrast = i >= 0.8 ? (i >= 1 ? 1.3 : 1.18) : 1
            return mix(fx, over: image, amount: GroupedIntensity.mixAmount(i), extraContrast: contrast == 1 ? GroupedIntensity.extraContrast(i) : contrast)
        case "thermal":
            let fx = image.applyingFilter("CIThermal")
            return mix(fx, over: image, amount: GroupedIntensity.mixAmount(i), extraContrast: GroupedIntensity.extraContrast(i))
        case "x_ray":
            let fx = image.applyingFilter("CIXRay")
            return mix(fx, over: image, amount: GroupedIntensity.mixAmount(i), extraContrast: GroupedIntensity.extraContrast(i))
        case "glow":
            let radius = 10 * scale
            return image.applyingFilter("CIBloom", parameters: [kCIInputRadiusKey: radius, kCIInputIntensityKey: i])
        case "gloom":
            let radius = 10 * scale
            return image.applyingFilter("CIGloom", parameters: [kCIInputRadiusKey: radius, kCIInputIntensityKey: i])
        case "color_splash":
            return colorSplash(op, to: image)
        default:
            return image
        }
    }

    static func colorSplash(_ op: StylizeOp, to image: CIImage) -> CIImage {
        let color = op.color.flatMap(RGBAColor.parse) ?? RGBAColor(r: 1, g: 0, b: 0, a: 1)
        let targetHue = hueDegrees(r: color.r, g: color.g, b: color.b)
        let i = op.intensity
        let width = GroupedIntensity.lerp(i, 10, 15, 25, 35, 40)
        let outsideSat = i < 0.5 ? GroupedIntensity.lerp(i, 1, 0.5, 0, 0, 0) : 0
        let cube = LutBaker.colorSplashCube(targetHue: targetHue, width: width, outsideSaturation: outsideSat)
        return image.applyingFilter("CIColorCubeWithColorSpace", parameters: [
            "inputCubeDimension": 33,
            "inputCubeData": cube,
            "inputColorSpace": CGColorSpace(name: CGColorSpace.sRGB)!,
        ])
    }

    static func hueDegrees(r: Double, g: Double, b: Double) -> Double {
        let maxc = max(r, g, b), minc = min(r, g, b)
        let d = maxc - minc
        if d < 1e-6 { return 0 }
        let h: Double
        if maxc == r { h = (g - b) / d }
        else if maxc == g { h = 2 + (b - r) / d }
        else { h = 4 + (r - g) / d }
        return (h * 60).truncatingRemainder(dividingBy: 360) + (h * 60 < 0 ? 360 : 0)
    }

    // MARK: - blur_sharpen

    static func blurSharpen(_ op: BlurSharpenOp, to image: CIImage, size: CGSize) -> CIImage {
        let i = op.intensity
        let S = shortSide(size)
        let scale = refScale(size)
        let center = ciPoint(x: op.centerX, y: op.centerY, size: size)
        func radius(_ factor: Double) -> Double {
            if let px = op.radiusPx { return min(100, px * Double(scale)) }
            return factor * Double(S) * i
        }
        switch op.mode {
        case "blur":
            let r = radius(0.02)
            return image.clampedToExtent().applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: r]).cropped(to: image.extent)
        case "motion_blur":
            let r = radius(0.03)
            let angle = (op.angleDegrees ?? 0) * .pi / 180
            return image.clampedToExtent().applyingFilter("CIMotionBlur", parameters: [kCIInputRadiusKey: r, kCIInputAngleKey: angle]).cropped(to: image.extent)
        case "zoom_blur":
            let amount = radius(0.03)
            return image.clampedToExtent().applyingFilter("CIZoomBlur", parameters: [kCIInputCenterKey: center, "inputAmount": amount]).cropped(to: image.extent)
        case "lens_blur":
            let r: Double
            if let px = op.radiusPx { r = min(500, px * Double(scale)) } else { r = 0.02 * Double(S) * i }
            return image.clampedToExtent().applyingFilter("CIBokehBlur", parameters: [kCIInputRadiusKey: r]).cropped(to: image.extent)
        case "tilt_shift":
            return tiltShift(op, to: image, size: size)
        case "sharpen":
            let sharpness = GroupedIntensity.curve(i, from: 0, mid: 1, to: 2)
            return image.applyingFilter("CISharpenLuminance", parameters: ["inputSharpness": sharpness, kCIInputRadiusKey: 1.69])
        case "denoise":
            let level = GroupedIntensity.curve(i, from: 0, mid: 0.05, to: 0.1)
            return image.applyingFilter("CINoiseReduction", parameters: ["inputNoiseLevel": level, "inputSharpness": 0.4])
        default:
            return image
        }
    }

    static func tiltShift(_ op: BlurSharpenOp, to image: CIImage, size: CGSize) -> CIImage {
        let i = op.intensity
        let scale = refScale(size)
        let radius = GroupedIntensity.lerp(i, 0, 2.5, 5, 8, 10) * Double(scale)
        let cy = (1 - (op.centerY ?? 0.5)) * size.height
        let band = size.height * 0.15
        let top = CIVector(x: size.width / 2, y: cy + band)
        let bottom = CIVector(x: size.width / 2, y: cy - band)
        // Mask: 1 (blurred) outside the sharp band, 0 inside.
        let grad = CIFilter(name: "CISmoothLinearGradient", parameters: [
            "inputPoint0": CIVector(x: size.width / 2, y: cy),
            "inputPoint1": top,
            "inputColor0": CIColor(red: 0, green: 0, blue: 0, alpha: 1),
            "inputColor1": CIColor(red: 1, green: 1, blue: 1, alpha: 1),
        ])?.outputImage
        let grad2 = CIFilter(name: "CISmoothLinearGradient", parameters: [
            "inputPoint0": CIVector(x: size.width / 2, y: cy),
            "inputPoint1": bottom,
            "inputColor0": CIColor(red: 0, green: 0, blue: 0, alpha: 1),
            "inputColor1": CIColor(red: 1, green: 1, blue: 1, alpha: 1),
        ])?.outputImage
        let mask: CIImage
        if let g1 = grad, let g2 = grad2 {
            mask = g1.applyingFilter("CIMaximumCompositing", parameters: [kCIInputBackgroundImageKey: g2]).cropped(to: image.extent)
        } else {
            mask = CIImage(color: .white).cropped(to: image.extent)
        }
        let blurred = image.clampedToExtent().applyingFilter("CIMaskedVariableBlur", parameters: [
            "inputMask": mask, kCIInputRadiusKey: radius,
        ]).cropped(to: image.extent)
        return blurred.applyingFilter("CIColorControls", parameters: [kCIInputSaturationKey: 1.2])
    }

    // MARK: - lut

    static func lut(_ op: LutOp, to image: CIImage) -> CIImage {
        let photo: String? = [
            "noir": "CIPhotoEffectNoir", "chrome": "CIPhotoEffectChrome", "fade": "CIPhotoEffectFade",
            "instant": "CIPhotoEffectInstant", "mono": "CIPhotoEffectMono", "process": "CIPhotoEffectProcess",
            "tonal": "CIPhotoEffectTonal",
        ][op.preset]
        let graded: CIImage
        if let photo {
            graded = image.applyingFilter(photo)
        } else if let cube = LutBaker.cube(for: op.preset) {
            graded = image.applyingFilter("CIColorCubeWithColorSpace", parameters: [
                "inputCubeDimension": LutBaker.dimension,
                "inputCubeData": cube,
                "inputColorSpace": CGColorSpace(name: CGColorSpace.sRGB)!,
            ])
        } else {
            return image
        }
        return mix(graded, over: image, amount: GroupedIntensity.mixAmount(op.intensity), extraContrast: GroupedIntensity.extraContrast(op.intensity))
    }

    // MARK: - vignette_grain

    static func vignetteGrain(_ op: VignetteGrainOp, to image: CIImage, size: CGSize, time: Double) -> CIImage {
        var out = image
        let wantsVignette = op.effect == "vignette" || op.effect == "vignette_and_grain" || op.effect == "light_vignette"
        let wantsGrain = op.effect == "grain" || op.effect == "vignette_and_grain"
        if wantsVignette {
            let halfDiag = hypot(size.width, size.height) / 2
            let radiusFactor = 1 - 0.5 * op.intensity
            let radius = halfDiag * CGFloat(radiusFactor)
            var amount: Double
            if let override = op.vignetteAmount {
                amount = override
            } else {
                amount = min(1, 0.4 + 1.2 * op.intensity)
                if op.effect == "light_vignette" { amount = -amount }
            }
            out = out.applyingFilter("CIVignetteEffect", parameters: [
                kCIInputCenterKey: CIVector(x: size.width / 2, y: size.height / 2),
                kCIInputRadiusKey: radius,
                kCIInputIntensityKey: amount,
                "inputFalloff": 0.5,
            ])
        }
        if wantsGrain {
            let a = (op.grainAmount ?? op.intensity) * 0.12
            out = addGrain(to: out, size: size, amplitude: a, time: time)
        }
        return out
    }

    static func addGrain(to image: CIImage, size: CGSize, amplitude: Double, time: Double) -> CIImage {
        let scale = 1.5 * refScale(size)
        // Seeded per-frame offset so video grain isn't a static dirty-lens overlay.
        var seed = UInt64(max(0, time * 30).rounded()) &* 1_103_515_245 &+ 12345
        seed = seed &* 1_103_515_245 &+ 12345
        let ox = CGFloat(seed % 1024)
        seed = seed &* 1_103_515_245 &+ 12345
        let oy = CGFloat(seed % 1024)
        let noise = CIFilter(name: "CIRandomGenerator")?.outputImage?
            .transformed(by: CGAffineTransform(translationX: ox, y: oy))
            .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            .cropped(to: image.extent)
        guard let noise else { return image }
        let gray = noise.applyingFilter("CIColorMatrix", parameters: [
            "inputRVector": CIVector(x: 0.3, y: 0.3, z: 0.3, w: 0),
            "inputGVector": CIVector(x: 0.3, y: 0.3, z: 0.3, w: 0),
            "inputBVector": CIVector(x: 0.3, y: 0.3, z: 0.3, w: 0),
            "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 0),
            "inputBiasVector": CIVector(x: -0.5 * amplitude, y: -0.5 * amplitude, z: -0.5 * amplitude, w: 1),
        ]).applyingFilter("CIColorMatrix", parameters: [
            "inputRVector": CIVector(x: amplitude, y: 0, z: 0, w: 0),
            "inputGVector": CIVector(x: 0, y: amplitude, z: 0, w: 0),
            "inputBVector": CIVector(x: 0, y: 0, z: amplitude, w: 0),
            "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 1),
        ])
        return gray.applyingFilter("CIAdditionCompositing", parameters: [kCIInputBackgroundImageKey: image])
    }

    // MARK: - segment

    static func segment(_ op: SegmentOp, to image: CIImage, size: CGSize, time: Double, session: SegmentSession?) -> CIImage {
        let session = session ?? SegmentSession()
        switch op.action {
        case "blur_faces", "pixelate_faces":
            return facePrivacy(op, to: image, size: size, time: time, session: session)
        default:
            return backgroundEdit(op, to: image, size: size, time: time, session: session)
        }
    }

    static func backgroundEdit(_ op: SegmentOp, to image: CIImage, size: CGSize, time: Double, session: SegmentSession) -> CIImage {
        guard let mask = session.personMask(for: image, time: time, subject: op.subject) else {
            // No subject: the whole frame is "background".
            return applyBackground(op, to: image, size: size, original: image, mask: nil)
        }
        return applyBackground(op, to: image, size: size, original: image, mask: mask)
    }

    static func applyBackground(_ op: SegmentOp, to image: CIImage, size: CGSize, original: CIImage, mask: CIImage?) -> CIImage {
        let S = shortSide(size)
        let i = op.intensity
        let background: CIImage
        switch op.action {
        case "blur_background":
            let r = min(100, 0.04 * Double(S) * i)
            background = image.clampedToExtent().applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: r]).cropped(to: image.extent)
        case "replace_background":
            background = CIImage(color: ciColor(op.backgroundColor, fallback: .white)).cropped(to: image.extent)
        case "remove_background":
            // Photos keep alpha (transparent); video is a solid colour (default black).
            if mask == nil {
                return CIImage(color: ciColor(op.backgroundColor, fallback: RGBAColor(r: 0, g: 0, b: 0, a: 1))).cropped(to: image.extent)
            }
            let color = op.backgroundColor.flatMap(RGBAColor.parse)
            if let color, color.a > 0 {
                background = CIImage(color: CIColor(red: color.r, green: color.g, blue: color.b, alpha: 1)).cropped(to: image.extent)
            } else {
                // Transparent background for photos (and when no colour was given).
                return original.applyingFilter("CIBlendWithMask", parameters: [
                    kCIInputBackgroundImageKey: CIImage(color: CIColor(red: 0, green: 0, blue: 0, alpha: 0)).cropped(to: image.extent),
                    kCIInputMaskImageKey: mask!,
                ])
            }
        case "color_pop":
            let sat = i < 0.5 ? GroupedIntensity.lerp(i, 1, 0.5, 0, 0, 0) : 0
            let contrast = i > 0.5 ? 1 + 0.2 * (2 * (i - 0.5)) : 1
            background = image.applyingFilter("CIColorControls", parameters: [
                kCIInputSaturationKey: sat, kCIInputContrastKey: contrast,
            ])
        case "darken_background":
            let ev = -GroupedIntensity.curve(i, from: 0, mid: 1, to: 2)
            background = image.applyingFilter("CIExposureAdjust", parameters: [kCIInputEVKey: ev])
        default:
            return image
        }
        guard let mask else { return background }
        return original.applyingFilter("CIBlendWithMask", parameters: [
            kCIInputBackgroundImageKey: background,
            kCIInputMaskImageKey: mask,
        ])
    }

    static func facePrivacy(_ op: SegmentOp, to image: CIImage, size: CGSize, time: Double, session: SegmentSession) -> CIImage {
        let boxes = session.faceBoxes(for: image, time: time)
        guard !boxes.isEmpty else { return image }
        let S = shortSide(size)
        let i = max(op.intensity, 0.5) // privacy floor
        var out = image
        for box in boxes {
            let grown = box.insetBy(dx: -box.width * 0.2, dy: -box.height * 0.2)
            let center = CIVector(x: grown.midX, y: grown.midY)
            let radius = max(grown.width, grown.height) * 0.6
            let mask = CIFilter(name: "CIRadialGradient", parameters: [
                kCIInputCenterKey: center,
                "inputRadius0": radius * 0.7,
                "inputRadius1": radius,
                "inputColor0": CIColor(red: 1, green: 1, blue: 1, alpha: 1),
                "inputColor1": CIColor(red: 0, green: 0, blue: 0, alpha: 1),
            ])?.outputImage?.cropped(to: image.extent)
            let treated: CIImage
            if op.action == "pixelate_faces" {
                let block = max(16 * refScale(size), 0.02 * S)
                treated = image.applyingFilter("CIPixellate", parameters: [kCIInputCenterKey: center, kCIInputScaleKey: block])
            } else {
                let r = max(12 * Double(refScale(size)), 0.03 * Double(S) * i)
                treated = image.clampedToExtent().applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: r]).cropped(to: image.extent)
            }
            if let mask {
                out = treated.applyingFilter("CIBlendWithMask", parameters: [
                    kCIInputBackgroundImageKey: out,
                    kCIInputMaskImageKey: mask,
                ])
            }
        }
        return out
    }
}

// MARK: - Vision session (one per compose / photo render)

final class SegmentSession: @unchecked Sendable {
    private let lock = NSLock()
    private let personRequest: VNGeneratePersonSegmentationRequest = {
        let r = VNGeneratePersonSegmentationRequest()
        r.qualityLevel = .balanced
        r.outputPixelFormat = kCVPixelFormatType_OneComponent8
        return r
    }()
    private let faceRequest = VNDetectFaceRectanglesRequest()
    private var previousMask: CIImage?
    private var lastFaceBoxes: [CGRect] = []
    private var lastFaceTime: Double = -1

    func personMask(for image: CIImage, time: Double, subject: String) -> CIImage? {
        lock.lock()
        defer { lock.unlock() }
        if subject == "any" {
            return foregroundMask(image)
        }
        guard let handler = makeHandler(image) else { return nil }
        do { try handler.perform([personRequest]) } catch { return previousMask }
        guard let obs = personRequest.results?.first else { return previousMask }
        var mask = CIImage(cvPixelBuffer: obs.pixelBuffer)
        let sx = image.extent.width / mask.extent.width
        let sy = image.extent.height / mask.extent.height
        mask = mask.transformed(by: CGAffineTransform(scaleX: sx, y: sy))
        if let previous = previousMask {
            mask = mask.applyingFilter("CIColorMatrix", parameters: [
                "inputRVector": CIVector(x: 0.6, y: 0, z: 0, w: 0),
                "inputGVector": CIVector(x: 0, y: 0.6, z: 0, w: 0),
                "inputBVector": CIVector(x: 0, y: 0, z: 0.6, w: 0),
                "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 0.6),
            ]).applyingFilter("CIAdditionCompositing", parameters: [
                kCIInputBackgroundImageKey: previous.applyingFilter("CIColorMatrix", parameters: [
                    "inputRVector": CIVector(x: 0.4, y: 0, z: 0, w: 0),
                    "inputGVector": CIVector(x: 0, y: 0.4, z: 0, w: 0),
                    "inputBVector": CIVector(x: 0, y: 0, z: 0.4, w: 0),
                    "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 0.4),
                ]),
            ])
        }
        let feather = max(1, 0.002 * min(image.extent.width, image.extent.height))
        mask = mask.clampedToExtent().applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: feather]).cropped(to: image.extent)
        previousMask = mask
        return mask
    }

    func faceBoxes(for image: CIImage, time: Double) -> [CGRect] {
        lock.lock()
        defer { lock.unlock() }
        // Detect every ~3 frames at 30 fps; hold the last boxes for 0.5 s.
        let shouldDetect = lastFaceTime < 0 || time - lastFaceTime >= 0.1 || time + 0.001 < lastFaceTime
        if shouldDetect, let handler = makeHandler(image) {
            do { try handler.perform([faceRequest]) } catch { /* keep last */ }
            if let results = faceRequest.results, !results.isEmpty {
                let e = image.extent
                lastFaceBoxes = results.map { obs in
                    let b = obs.boundingBox
                    return CGRect(x: b.minX * e.width, y: b.minY * e.height, width: b.width * e.width, height: b.height * e.height)
                }
                lastFaceTime = time
            }
        }
        if lastFaceTime >= 0, time - lastFaceTime > 0.5, time >= lastFaceTime {
            lastFaceBoxes = []
        }
        return lastFaceBoxes
    }

    private func foregroundMask(_ image: CIImage) -> CIImage? {
        let request = VNGenerateForegroundInstanceMaskRequest()
        guard let handler = makeHandler(image) else { return nil }
        do { try handler.perform([request]) } catch { return nil }
        guard let obs = request.results?.first,
              let buffer = try? obs.generateScaledMaskForImage(forInstances: obs.allInstances, from: handler) else { return nil }
        var mask = CIImage(cvPixelBuffer: buffer)
        let sx = image.extent.width / max(mask.extent.width, 1)
        let sy = image.extent.height / max(mask.extent.height, 1)
        mask = mask.transformed(by: CGAffineTransform(scaleX: sx, y: sy))
        let feather = max(1, 0.002 * min(image.extent.width, image.extent.height))
        return mask.clampedToExtent().applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: feather]).cropped(to: image.extent)
    }

    private func makeHandler(_ image: CIImage) -> VNImageRequestHandler? {
        let long = max(image.extent.width, image.extent.height)
        let scale = long > 512 ? 512 / long : 1
        var working = image
        if scale < 1 {
            working = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        }
        guard let cg = GroupedEffectRenderer.context.createCGImage(working, from: working.extent) else { return nil }
        return VNImageRequestHandler(cgImage: cg, options: [:])
    }
}

// MARK: - LUT baker

enum LutBaker {
    static let dimension = 33
    private static let lock = NSLock()
    private static var cache: [String: Data] = [:]

    static func cube(for preset: String) -> Data? {
        lock.lock()
        if let data = cache[preset] { lock.unlock(); return data }
        lock.unlock()
        guard let data = bake(preset) else { return nil }
        lock.lock(); cache[preset] = data; lock.unlock()
        return data
    }

    static func colorSplashCube(targetHue: Double, width: Double, outsideSaturation: Double) -> Data {
        identityCube { r, g, b in
            let h = GroupedEffectRenderer.hueDegrees(r: r, g: g, b: b)
            var dh = abs(h - targetHue)
            if dh > 180 { dh = 360 - dh }
            let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
            if dh <= width { return (r, g, b) }
            let s = outsideSaturation
            return (luma * (1 - s) + r * s, luma * (1 - s) + g * s, luma * (1 - s) + b * s)
        }
    }

    private static func bake(_ preset: String) -> Data? {
        let identity = identityImage()
        let graded: CIImage
        switch preset {
        case "cinematic":
            // Teal shadows, orange highlights, slight contrast.
            let contrasted = identity.applyingFilter("CIColorControls", parameters: [kCIInputContrastKey: 1.1])
            graded = splitTone(contrasted, shadows: (0, 0.1, 0.15), highlights: (0.15, 0.07, 0), amount: 0.35)
        case "warm_film":
            var img = identity.applyingFilter("CITemperatureAndTint", parameters: [
                "inputNeutral": CIVector(x: 8000, y: 0), "inputTargetNeutral": CIVector(x: 6500, y: 0),
            ])
            img = img.applyingFilter("CIHighlightShadowAdjust", parameters: ["inputShadowAmount": 0.1])
            img = img.applyingFilter("CIColorControls", parameters: [kCIInputSaturationKey: 0.9])
            graded = sCurve(img, amount: 0.4)
        case "cool_film":
            var img = identity.applyingFilter("CITemperatureAndTint", parameters: [
                "inputNeutral": CIVector(x: 5000, y: -15), "inputTargetNeutral": CIVector(x: 6500, y: 0),
            ])
            graded = matte(img, floor: 0.05, ceil: 1)
        case "bleach_bypass":
            let gray = identity.applyingFilter("CIColorControls", parameters: [kCIInputSaturationKey: 0])
            let mixed = FrameRenderer.blend(gray, over: identity, amount: 0.5)
            graded = mixed.applyingFilter("CIColorControls", parameters: [kCIInputSaturationKey: 0.5, kCIInputContrastKey: 1.3])
        case "golden_hour":
            var img = identity.applyingFilter("CIColorMatrix", parameters: [
                "inputRVector": CIVector(x: 1.08, y: 0, z: 0, w: 0),
                "inputGVector": CIVector(x: 0, y: 1.0, z: 0, w: 0),
                "inputBVector": CIVector(x: 0, y: 0, z: 0.85, w: 0),
                "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 1),
            ])
            img = img.applyingFilter("CIHighlightShadowAdjust", parameters: ["inputHighlightAmount": 0.7])
            graded = img.applyingFilter("CIVibrance", parameters: ["inputAmount": 0.3])
        case "moody":
            var img = identity.applyingFilter("CIExposureAdjust", parameters: [kCIInputEVKey: -0.3])
            img = img.applyingFilter("CIColorControls", parameters: [kCIInputSaturationKey: 0.75, kCIInputContrastKey: 1.15])
            graded = splitTone(img, shadows: (0, 0.02, 0.08), highlights: (0, 0, 0), amount: 0.25)
        case "matte":
            graded = matte(identity.applyingFilter("CIColorControls", parameters: [kCIInputSaturationKey: 0.9]), floor: 0.08, ceil: 0.95)
        case "vivid":
            graded = identity
                .applyingFilter("CIVibrance", parameters: ["inputAmount": 0.5])
                .applyingFilter("CIColorControls", parameters: [kCIInputContrastKey: 1.15])
        case "pastel":
            var img = identity.applyingFilter("CIHighlightShadowAdjust", parameters: ["inputShadowAmount": 0.15])
            img = img.applyingFilter("CIColorControls", parameters: [kCIInputSaturationKey: 0.7])
            graded = img.applyingFilter("CIColorMatrix", parameters: [
                "inputRVector": CIVector(x: 1, y: 0, z: 0, w: 0),
                "inputGVector": CIVector(x: 0, y: 1, z: 0, w: 0),
                "inputBVector": CIVector(x: 0, y: 0, z: 1, w: 0),
                "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 1),
                "inputBiasVector": CIVector(x: 0.03, y: 0.01, z: 0.02, w: 0),
            ])
        default:
            return nil
        }
        return renderCube(graded)
    }

    private static func identityImage() -> CIImage {
        let n = dimension
        var pixels = [Float](repeating: 0, count: n * n * n * 4)
        var i = 0
        for b in 0..<n {
            for g in 0..<n {
                for r in 0..<n {
                    pixels[i] = Float(r) / Float(n - 1)
                    pixels[i + 1] = Float(g) / Float(n - 1)
                    pixels[i + 2] = Float(b) / Float(n - 1)
                    pixels[i + 3] = 1
                    i += 4
                }
            }
        }
        return pixels.withUnsafeBytes { raw in
            CIImage(
                bitmapData: Data(raw),
                bytesPerRow: n * 16,
                size: CGSize(width: n, height: n * n),
                format: .RGBAf,
                colorSpace: CGColorSpace(name: CGColorSpace.sRGB)
            )
        }
    }

    private static func renderCube(_ image: CIImage) -> Data? {
        let n = dimension
        var out = [Float](repeating: 0, count: n * n * n * 4)
        let ok = out.withUnsafeMutableBytes { raw in
            GroupedEffectRenderer.context.render(
                image,
                toBitmap: raw.baseAddress!,
                rowBytes: n * 16,
                bounds: CGRect(x: 0, y: 0, width: n, height: n * n),
                format: .RGBAf,
                colorSpace: CGColorSpace(name: CGColorSpace.sRGB)
            )
            return true
        }
        return ok ? out.withUnsafeBytes { Data($0) } : nil
    }

    static func identityCube(_ map: (Double, Double, Double) -> (Double, Double, Double)) -> Data {
        let n = dimension
        var pixels = [Float](repeating: 0, count: n * n * n * 4)
        var i = 0
        for b in 0..<n {
            for g in 0..<n {
                for r in 0..<n {
                    let (R, G, B) = map(Double(r) / Double(n - 1), Double(g) / Double(n - 1), Double(b) / Double(n - 1))
                    pixels[i] = Float(R); pixels[i + 1] = Float(G); pixels[i + 2] = Float(B); pixels[i + 3] = 1
                    i += 4
                }
            }
        }
        return pixels.withUnsafeBytes { Data($0) }
    }

    private static func splitTone(_ image: CIImage, shadows: (Double, Double, Double), highlights: (Double, Double, Double), amount: Double) -> CIImage {
        // Approximate: lift + colour matrix mixed by a mid-grey key. Good enough as a bake starting point.
        let shadowBias = CIVector(x: shadows.0 * amount, y: shadows.1 * amount, z: shadows.2 * amount, w: 0)
        let highGain = CIVector(x: 1 + highlights.0 * amount, y: 0, z: 0, w: 0)
        let highGainG = CIVector(x: 0, y: 1 + highlights.1 * amount, z: 0, w: 0)
        let highGainB = CIVector(x: 0, y: 0, z: 1 + highlights.2 * amount, w: 0)
        return image.applyingFilter("CIColorMatrix", parameters: [
            "inputRVector": highGain, "inputGVector": highGainG, "inputBVector": highGainB,
            "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 1),
            "inputBiasVector": shadowBias,
        ])
    }

    private static func sCurve(_ image: CIImage, amount: Double) -> CIImage {
        // Mix identity (0,1,0,0) with smoothstep (0,0,3,-2).
        let a1 = 1 - amount
        let a2 = 0 + 3 * amount
        let a3 = -2 * amount
        let c = CIVector(x: 0, y: a1, z: a2, w: a3)
        return image.applyingFilter("CIColorPolynomial", parameters: [
            "inputRedCoefficients": c, "inputGreenCoefficients": c, "inputBlueCoefficients": c,
        ])
    }

    private static func matte(_ image: CIImage, floor: Double, ceil: Double) -> CIImage {
        let scale = ceil - floor
        return image.applyingFilter("CIColorMatrix", parameters: [
            "inputRVector": CIVector(x: scale, y: 0, z: 0, w: 0),
            "inputGVector": CIVector(x: 0, y: scale, z: 0, w: 0),
            "inputBVector": CIVector(x: 0, y: 0, z: scale, w: 0),
            "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 1),
            "inputBiasVector": CIVector(x: floor, y: floor, z: floor, w: 0),
        ])
    }
}
