import Foundation

// MARK: - Ops (non-destructive edit-stack entries)

struct ChannelMixerOp: Equatable, Sendable {
    var preset: String
    var intensity: Double
    var matrix: [[Double]]?
}

struct ColorAdjustValues: Equatable, Sendable {
    var exposureEV: Double?
    var brightness: Double?
    var contrast: Double?
    var saturation: Double?
    var vibrance: Double?
    var temperatureShiftK: Double?
    var tintShift: Double?
    var hueDegrees: Double?
    var gamma: Double?
    var shadows: Double?
    var highlights: Double?
}

struct ColorAdjustOp: Equatable, Sendable {
    var adjust: [String]
    var intensity: Double
    var intensityPerChange: [String: Double]
    var values: ColorAdjustValues
}

struct ApplyFilterOp: Equatable, Sendable {
    var name: String
    var intensity: Double
    var centerX: Double?
    var centerY: Double?
    var color: String?
    var color2: String?
    var params: [String: JSONValue]
}

struct StylizeOp: Equatable, Sendable {
    var preset: String
    var intensity: Double
    var color: String?
}

struct BlurSharpenOp: Equatable, Sendable {
    var mode: String
    var intensity: Double
    var angleDegrees: Double?
    var centerX: Double?
    var centerY: Double?
    var radiusPx: Double?
}

struct LutOp: Equatable, Sendable {
    var preset: String
    var intensity: Double
}

struct VignetteGrainOp: Equatable, Sendable {
    var effect: String
    var intensity: Double
    var vignetteAmount: Double?
    var grainAmount: Double?
}

struct SegmentOp: Equatable, Sendable {
    var action: String
    var subject: String
    var backgroundColor: String?
    var intensity: Double
}

struct AudioEffectOp: Equatable, Sendable {
    var effect: String
    var intensity: Double
    var reverbPreset: String?
    var pitchSemitones: Double?
    var delaySeconds: Double?
    var mixPercent: Double?
    var gainDb: Double?
    var frequencyHz: Double?
}

// MARK: - Enumerations (server schema: src/server/iosGroupedTools.js)

enum GroupedToolCatalog {
    static let channelMixerPresets: Set<String> = [
        "remove_red", "remove_green", "remove_blue",
        "isolate_red", "isolate_green", "isolate_blue",
        "swap_rb", "swap_rg", "swap_gb",
        "grayscale_by_red", "grayscale_by_green", "grayscale_by_blue",
        "invert_red", "invert_green", "invert_blue", "custom",
    ]

    static let colorAdjustments: Set<String> = [
        "brighter", "darker", "more_contrast", "less_contrast",
        "more_saturation", "less_saturation", "more_vibrance", "less_vibrance",
        "warmer", "cooler", "greener", "more_magenta",
        "lift_shadows", "deepen_shadows", "recover_highlights",
        "brighter_midtones", "darker_midtones", "hue_shift",
    ]

    static let applyFilters: Set<String> = [
        "twirl", "vortex", "bulge", "bulge_line", "pinch", "circle_splash", "hole",
        "light_tunnel", "torus_lens", "glass_lozenge", "circular_wrap", "droste",
        "kaleidoscope", "triangle_kaleidoscope", "op_art_tile",
        "mirror_tile_4", "rotated_tile_6", "mirror_tile_8", "mirror_tile_12",
        "dot_screen", "line_screen", "hatched_screen", "circular_screen", "cmyk_halftone",
        "monochrome_tint", "duotone", "white_point", "dither",
        "max_component_gray", "min_component_gray", "threshold",
        "sunbeams", "lens_flare", "star_shine",
    ]

    static let stylizePresets: Set<String> = [
        "comic", "posterize", "pixellate", "hex_pixellate", "crystallize", "pointillize",
        "edges", "woodcut", "sketch", "thermal", "x_ray", "glow", "gloom", "color_splash",
    ]

    static let blurModes: Set<String> = [
        "blur", "motion_blur", "zoom_blur", "lens_blur", "tilt_shift", "sharpen", "denoise",
    ]

    static let lutPresets: Set<String> = [
        "noir", "chrome", "fade", "instant", "mono", "process", "tonal",
        "cinematic", "warm_film", "cool_film", "bleach_bypass",
        "golden_hour", "moody", "matte", "vivid", "pastel",
    ]

    static let vignetteEffects: Set<String> = [
        "vignette", "grain", "vignette_and_grain", "light_vignette",
    ]

    static let segmentActions: Set<String> = [
        "blur_background", "replace_background", "remove_background",
        "color_pop", "darken_background", "blur_faces", "pixelate_faces",
    ]

    static let audioEffects: Set<String> = [
        "bass_boost", "bass_cut", "treble_boost", "treble_cut", "voice_boost",
        "remove_rumble", "muffle", "telephone", "reverb", "echo",
        "pitch_up", "pitch_down", "robot", "radio", "distortion", "noise_gate",
    ]

    static let reverbPresets: Set<String> = [
        "small_room", "medium_room", "large_room", "medium_hall", "large_hall",
        "plate", "medium_chamber", "large_chamber", "cathedral",
    ]

    static let photoTools: Set<String> = [
        "channel_mixer", "color_adjust", "apply_filter", "stylize",
        "blur_sharpen", "lut", "vignette_grain", "segment",
    ]

    static let allTools: [String] = [
        "channel_mixer", "color_adjust", "apply_filter", "stylize",
        "blur_sharpen", "lut", "vignette_grain", "segment", "audio_effect",
    ]

    /// apply_filter names that actually belong to another tool (ON_DEVICE_TOOLS.md §8.3 / §9.4).
    static func routedOwner(forApplyFilter name: String) -> (tool: String, key: String, value: String)? {
        if lutPresets.contains(name) { return ("lut", "preset", name) }
        if stylizePresets.contains(name) { return ("stylize", "preset", name) }
        if blurModes.contains(name) { return ("blur_sharpen", "mode", name) }
        if NativeToolParser.colorFilters.contains(name) { return ("apply_color_filter", "filter", name) }
        switch name {
        case "transfer": return ("apply_color_filter", "filter", "vintage")
        case "sepia": return ("apply_color_filter", "filter", "sepia")
        default: return nil
        }
    }
}

// MARK: - Intensity / clamp (ON_DEVICE_TOOLS.md §9.0)

enum GroupedIntensity {
    static func clamp(_ x: Double, _ a: Double, _ b: Double) -> Double { min(b, max(a, x)) }
    static func clamp01(_ x: Double) -> Double { clamp(x, 0, 1) }

    /// Identity `p0`, medium `pm` (at 0.5), maximum `p1` (at 1.0).
    static func curve(_ i: Double, from p0: Double, mid pm: Double, to p1: Double) -> Double {
        let i = clamp01(i)
        if i <= 0.5 { return p0 + (pm - p0) * (2 * i) }
        return pm + (p1 - pm) * (2 * i - 1)
    }

    /// Mix presets: 0.25 = 50%, 0.5+ = 100%.
    static func mixAmount(_ i: Double) -> Double { min(1, 2 * clamp01(i)) }

    /// Extra contrast applied on mix presets when intensity > 0.5.
    static func extraContrast(_ i: Double) -> Double {
        let i = clamp01(i)
        return i > 0.5 ? 1 + 0.3 * (2 * i - 1) : 1
    }

    static func lerp(_ i: Double, _ p0: Double, _ p25: Double, _ p50: Double, _ p80: Double, _ p100: Double) -> Double {
        let i = clamp01(i)
        let points: [(Double, Double)] = [(0, p0), (0.25, p25), (0.5, p50), (0.8, p80), (1, p100)]
        for idx in 0..<(points.count - 1) {
            let (a, av) = points[idx]
            let (b, bv) = points[idx + 1]
            if i <= b {
                let t = b == a ? 0 : (i - a) / (b - a)
                return av + (bv - av) * t
            }
        }
        return p100
    }
}

// MARK: - Parser

enum GroupedToolParser {
    static func plan(tool: String, arguments a: [String: JSONValue], canvas: NativeCanvas) -> Result<NativePlan, NativeToolError> {
        if canvas.isPhoto, !GroupedToolCatalog.photoTools.contains(tool) {
            return .failure(.unsupportedForPhoto)
        }
        func num(_ key: String) -> Double? {
            guard let v = a[key] else { return nil }
            if let d = v.doubleValue, d.isFinite { return d }
            return nil
        }
        func optionalNum(_ key: String) -> Double? {
            guard let v = a[key], v != .null else { return nil }
            return num(key)
        }
        func intensity() -> Double {
            guard a["intensity"] != nil, a["intensity"] != .null else { return 0.5 }
            return GroupedIntensity.clamp01(num("intensity") ?? 0.5)
        }
        func bad(_ why: String) -> Result<NativePlan, NativeToolError> { .failure(.invalidArguments(why)) }
        func op(_ o: NativeOp) -> Result<NativePlan, NativeToolError> { .success(.apply(o)) }

        switch tool {
        case "channel_mixer":
            guard let preset = a["preset"]?.stringValue, GroupedToolCatalog.channelMixerPresets.contains(preset) else {
                return .failure(.unsupportedOnDevice)
            }
            var matrix: [[Double]]?
            if preset == "custom" {
                guard let rows = a["matrix"]?.arrayValue, rows.count == 4 else { return bad("matrix") }
                var parsed: [[Double]] = []
                for row in rows {
                    guard let cells = row.arrayValue, cells.count == 5 else { return bad("matrix") }
                    var nums: [Double] = []
                    for (i, cell) in cells.enumerated() {
                        guard let d = cell.doubleValue, d.isFinite else { return bad("matrix") }
                        nums.append(i < 4 ? GroupedIntensity.clamp(d, -2, 2) : GroupedIntensity.clamp(d, -1, 1))
                    }
                    parsed.append(nums)
                }
                matrix = parsed
            }
            return op(.channelMixer(ChannelMixerOp(preset: preset, intensity: intensity(), matrix: matrix)))

        case "color_adjust":
            guard let raw = a["adjust"]?.arrayValue, !raw.isEmpty else { return bad("adjust") }
            var adjusts: [String] = []
            for item in raw {
                guard let name = item.stringValue, GroupedToolCatalog.colorAdjustments.contains(name) else {
                    return .failure(.unsupportedOnDevice)
                }
                adjusts.append(name)
            }
            var per: [String: Double] = [:]
            if let obj = a["intensity_per_change"]?.objectValue {
                for (k, v) in obj {
                    if let d = v.doubleValue, d.isFinite { per[k] = GroupedIntensity.clamp01(d) }
                }
            }
            return op(.colorAdjust(ColorAdjustOp(
                adjust: adjusts, intensity: intensity(),
                intensityPerChange: per, values: parseValues(a["values"]))))

        case "apply_filter":
            guard let name = a["name"]?.stringValue else { return bad("name") }
            if let route = GroupedToolCatalog.routedOwner(forApplyFilter: name) {
                var routed = a
                routed[route.key] = .string(route.value)
                return NativeToolParser.plan(tool: route.tool, arguments: routed, canvas: canvas)
            }
            guard GroupedToolCatalog.applyFilters.contains(name) else { return .failure(.unsupportedOnDevice) }
            return op(.applyFilter(ApplyFilterOp(
                name: name, intensity: intensity(),
                centerX: optionalNum("center_x").map { GroupedIntensity.clamp01($0) },
                centerY: optionalNum("center_y").map { GroupedIntensity.clamp01($0) },
                color: a["color"]?.stringValue,
                color2: a["color2"]?.stringValue,
                params: a["params"]?.objectValue ?? [:])))

        case "stylize":
            guard let preset = a["preset"]?.stringValue, GroupedToolCatalog.stylizePresets.contains(preset) else {
                return .failure(.unsupportedOnDevice)
            }
            return op(.stylize(StylizeOp(preset: preset, intensity: intensity(), color: a["color"]?.stringValue)))

        case "blur_sharpen":
            guard let mode = a["mode"]?.stringValue, GroupedToolCatalog.blurModes.contains(mode) else {
                return .failure(.unsupportedOnDevice)
            }
            return op(.blurSharpen(BlurSharpenOp(
                mode: mode, intensity: intensity(),
                angleDegrees: optionalNum("angle_degrees").map { GroupedIntensity.clamp($0, -180, 180) },
                centerX: optionalNum("center_x").map { GroupedIntensity.clamp01($0) },
                centerY: optionalNum("center_y").map { GroupedIntensity.clamp01($0) },
                radiusPx: optionalNum("radius_px").map { GroupedIntensity.clamp($0, 0, 100) })))

        case "lut":
            guard let preset = a["preset"]?.stringValue, GroupedToolCatalog.lutPresets.contains(preset) else {
                return .failure(.unsupportedOnDevice)
            }
            return op(.lut(LutOp(preset: preset, intensity: intensity())))

        case "vignette_grain":
            guard let effect = a["effect"]?.stringValue, GroupedToolCatalog.vignetteEffects.contains(effect) else {
                return .failure(.unsupportedOnDevice)
            }
            return op(.vignetteGrain(VignetteGrainOp(
                effect: effect, intensity: intensity(),
                vignetteAmount: optionalNum("vignette_amount").map { GroupedIntensity.clamp($0, -1, 1) },
                grainAmount: optionalNum("grain_amount").map { GroupedIntensity.clamp01($0) })))

        case "segment":
            guard let action = a["action"]?.stringValue, GroupedToolCatalog.segmentActions.contains(action) else {
                return .failure(.unsupportedOnDevice)
            }
            let subject: String
            if let raw = a["subject"]?.stringValue {
                guard raw == "person" || raw == "any" else { return .failure(.unsupportedOnDevice) }
                subject = raw
            } else {
                subject = "person"
            }
            if subject == "any", !canvas.isPhoto { return .failure(.unsupportedOnDevice) }
            return op(.segment(SegmentOp(
                action: action, subject: subject,
                backgroundColor: a["background_color"]?.stringValue,
                intensity: intensity())))

        case "audio_effect":
            guard canvas.hasAudio else { return bad("no audio track") }
            guard let effect = a["effect"]?.stringValue, GroupedToolCatalog.audioEffects.contains(effect) else {
                return .failure(.unsupportedOnDevice)
            }
            var reverb: String?
            if let raw = a["reverb_preset"]?.stringValue {
                guard GroupedToolCatalog.reverbPresets.contains(raw) else { return .failure(.unsupportedOnDevice) }
                reverb = raw
            }
            return op(.audioEffect(AudioEffectOp(
                effect: effect, intensity: intensity(),
                reverbPreset: reverb,
                pitchSemitones: optionalNum("pitch_semitones").map { GroupedIntensity.clamp($0, -24, 24) },
                delaySeconds: optionalNum("delay_seconds").map { GroupedIntensity.clamp($0, 0.02, 2) },
                mixPercent: optionalNum("mix_percent").map { GroupedIntensity.clamp($0, 0, 100) },
                gainDb: optionalNum("gain_db").map { GroupedIntensity.clamp($0, -24, 24) },
                frequencyHz: optionalNum("frequency_hz").map { GroupedIntensity.clamp($0, 20, 20_000) })))

        default:
            return .failure(.unsupportedOnDevice)
        }
    }

    private static func parseValues(_ raw: JSONValue?) -> ColorAdjustValues {
        guard let obj = raw?.objectValue else { return ColorAdjustValues() }
        func n(_ key: String, _ lo: Double, _ hi: Double) -> Double? {
            guard let v = obj[key], v != .null, let d = v.doubleValue, d.isFinite else { return nil }
            return GroupedIntensity.clamp(d, lo, hi)
        }
        return ColorAdjustValues(
            exposureEV: n("exposure_ev", -3, 3),
            brightness: n("brightness", -1, 1),
            contrast: n("contrast", 0.25, 4),
            saturation: n("saturation", 0, 2),
            vibrance: n("vibrance", -1, 1),
            temperatureShiftK: n("temperature_shift_k", -4000, 4000),
            tintShift: n("tint_shift", -100, 100),
            hueDegrees: n("hue_degrees", -180, 180),
            gamma: n("gamma", 0.25, 4),
            shadows: n("shadows", -1, 1),
            highlights: n("highlights", 0.3, 1)
        )
    }
}
