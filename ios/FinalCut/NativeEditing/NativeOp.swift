import CoreGraphics
import Foundation

/// One on-device edit. Frame ops run in a Core Image chain; timeline ops fold into an
/// `AVMutableComposition`; audio ops become an `AVAudioMix`. Values are already validated
/// against the canvas/duration they were applied to.
enum NativeOp: Equatable, Sendable {
    // Timeline (video only)
    case trim(start: Double, end: Double)
    case speed(Double)
    // Frame (video + photo)
    case crop(x: Int, y: Int, width: Int, height: Int)
    case rotate(degrees: Double)
    case flipHorizontal
    case flipVertical
    case resize(width: Int, height: Int)
    case pad(width: Int, height: Int)
    case colorControls(brightness: Double, contrast: Double, saturation: Double)
    case hue(degrees: Double)
    case colorFilter(filter: String, intensity: Double)
    case text(String, x: Int, y: Int, fontSize: Int, color: RGBAColor)
    // Audio (video only)
    case volume(Double)
    case fade(isIn: Bool, duration: Double, start: Double?)
    // Output settings (applied on export)
    case outputFormat(String)

    var isTimeline: Bool {
        switch self { case .trim, .speed: return true; default: return false }
    }

    var isFrame: Bool {
        switch self {
        case .crop, .rotate, .flipHorizontal, .flipVertical, .resize, .pad, .colorControls, .hue, .colorFilter, .text:
            return true
        default:
            return false
        }
    }

    var isAudio: Bool {
        switch self { case .volume, .fade: return true; default: return false }
    }
}

struct RGBAColor: Equatable, Sendable {
    var r: Double, g: Double, b: Double, a: Double

    static let white = RGBAColor(r: 1, g: 1, b: 1, a: 1)

    var cgColor: CGColor { CGColor(srgbRed: r, green: g, blue: b, alpha: a) }

    private static let named: [String: RGBAColor] = [
        "white": .white,
        "black": RGBAColor(r: 0, g: 0, b: 0, a: 1),
        "red": RGBAColor(r: 1, g: 0, b: 0, a: 1),
        "green": RGBAColor(r: 0, g: 0.5, b: 0, a: 1),
        "lime": RGBAColor(r: 0, g: 1, b: 0, a: 1),
        "blue": RGBAColor(r: 0, g: 0, b: 1, a: 1),
        "yellow": RGBAColor(r: 1, g: 1, b: 0, a: 1),
        "cyan": RGBAColor(r: 0, g: 1, b: 1, a: 1),
        "magenta": RGBAColor(r: 1, g: 0, b: 1, a: 1),
        "orange": RGBAColor(r: 1, g: 0.647, b: 0, a: 1),
        "purple": RGBAColor(r: 0.5, g: 0, b: 0.5, a: 1),
        "pink": RGBAColor(r: 1, g: 0.753, b: 0.796, a: 1),
        "gray": RGBAColor(r: 0.5, g: 0.5, b: 0.5, a: 1),
        "grey": RGBAColor(r: 0.5, g: 0.5, b: 0.5, a: 1),
    ]

    /// Parses the server's `safeColor` forms: a name or `#rgb`/`#rrggbb`/`#rrggbbaa` (also `0x…`).
    static func parse(_ raw: String) -> RGBAColor? {
        let value = raw.trimmingCharacters(in: .whitespaces).lowercased()
        if let named = named[value] { return named }
        var hex = value
        if hex.hasPrefix("#") { hex.removeFirst() } else if hex.hasPrefix("0x") { hex.removeFirst(2) } else { return nil }
        if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
        guard hex.count == 6 || hex.count == 8, let v = UInt64(hex, radix: 16) else { return nil }
        if hex.count == 6 {
            return RGBAColor(r: Double((v >> 16) & 0xff) / 255, g: Double((v >> 8) & 0xff) / 255, b: Double(v & 0xff) / 255, a: 1)
        }
        return RGBAColor(r: Double((v >> 24) & 0xff) / 255, g: Double((v >> 16) & 0xff) / 255,
                         b: Double((v >> 8) & 0xff) / 255, a: Double(v & 0xff) / 255)
    }
}

/// The folded state an op is validated against.
struct NativeCanvas: Equatable, Sendable {
    var width: Int
    var height: Int
    /// Seconds (0 for photos).
    var duration: Double
    var isPhoto: Bool
    var hasAudio: Bool

    /// Applies `op`'s effect on size/duration.
    func applying(_ op: NativeOp) -> NativeCanvas {
        var next = self
        switch op {
        case .trim(let start, let end):
            next.duration = max(0, min(end, duration) - start)
        case .speed(let factor):
            next.duration = duration / factor
        case .crop(_, _, let w, let h):
            next.width = w; next.height = h
        case .rotate(let degrees):
            if Self.isQuarterTurn(degrees), Int((degrees / 90).rounded()).isOdd {
                swap(&next.width, &next.height)
            }
        case .resize(let w, let h), .pad(let w, let h):
            next.width = w; next.height = h
        default:
            break
        }
        return next
    }

    static func isQuarterTurn(_ degrees: Double) -> Bool {
        abs(degrees / 90 - (degrees / 90).rounded()) < 1e-6
    }
}

private extension Int {
    var isOdd: Bool { self % 2 != 0 }
}

enum NativeToolError: Error, Equatable {
    case invalidArguments(String)
    case unsupportedOnDevice
    case unsupportedForPhoto

    /// Stable string returned to the model.
    var toolError: String {
        switch self {
        case .invalidArguments: return ServerErrorCode.invalidArguments
        case .unsupportedOnDevice: return "unsupported_on_device"
        case .unsupportedForPhoto: return ServerErrorCode.unsupportedForPhoto
        }
    }
}

/// Result of parsing a tool call for on-device execution.
enum NativePlan: Equatable {
    /// Push this op onto the edit stack.
    case apply(NativeOp)
    /// Answer without changing the stack.
    case query(String)
}

/// Maps schema tool calls (docs/api/tools-schema.v1.json) onto `NativeOp`s, validating
/// arguments against the current canvas with the same rules as the server.
enum NativeToolParser {
    /// Tools that run on the device in this build (docs/ios/native-tools.md, "iOS allowlist").
    static let supportedTools: [String] = [
        "trim_video", "adjust_speed", "crop_video", "rotate_video", "flip_video_horizontal",
        "flip_video_vertical", "resize_video", "resize_video_preset", "adjust_brightness",
        "adjust_contrast", "adjust_saturation", "adjust_hue", "apply_color_filter", "add_text",
        "adjust_audio_volume", "audio_fade", "get_video_dimensions", "get_supported_formats",
        "convert_video_format", "convert_image_format",
    ]

    static let photoTools: Set<String> = [
        "crop_video", "rotate_video", "flip_video_horizontal", "flip_video_vertical", "resize_video",
        "resize_video_preset", "adjust_brightness", "adjust_contrast", "adjust_saturation", "adjust_hue",
        "apply_color_filter", "add_text", "convert_image_format", "get_video_dimensions", "get_supported_formats",
    ]

    static let colorFilters: Set<String> = [
        "red", "green", "blue", "yellow", "cyan", "magenta", "sepia", "grayscale",
        "black_and_white", "invert", "warm", "cool", "vintage",
    ]

    static let presets: [String: (Int, Int)] = [
        "9:16": (1080, 1920), "16:9": (1920, 1080), "1:1": (1080, 1080), "2:3": (1080, 1620), "3:2": (1620, 1080),
    ]

    static func isSupported(_ tool: String) -> Bool {
        supportedTools.contains(ToolCatalog.canonicalName(tool))
    }

    static func plan(tool rawName: String, arguments a: [String: JSONValue], canvas: NativeCanvas) -> Result<NativePlan, NativeToolError> {
        let tool = ToolCatalog.canonicalName(rawName)
        guard ToolCatalog.isKnown(tool) else { return .failure(.invalidArguments("unknown_tool")) }
        guard supportedTools.contains(tool) else {
            // Video-only tools on a photo are a clearer error than "not on device".
            if canvas.isPhoto, !photoTools.contains(tool) { return .failure(.unsupportedForPhoto) }
            return .failure(.unsupportedOnDevice)
        }
        if canvas.isPhoto, !photoTools.contains(tool) { return .failure(.unsupportedForPhoto) }
        let missing = ToolCatalog.missingRequiredArgs(tool: tool, arguments: a)
        if !missing.isEmpty { return .failure(.invalidArguments("missing: \(missing.joined(separator: ", "))")) }

        func num(_ key: String) -> Double? {
            guard let v = a[key] else { return nil }
            if let d = v.doubleValue, d.isFinite { return d }
            if let s = v.stringValue, let d = Double(s.trimmingCharacters(in: .whitespaces)), d.isFinite { return d }
            return nil
        }
        func bad(_ why: String) -> Result<NativePlan, NativeToolError> { .failure(.invalidArguments(why)) }
        func op(_ o: NativeOp) -> Result<NativePlan, NativeToolError> { .success(.apply(o)) }

        switch tool {
        case "get_video_dimensions", "get_supported_formats":
            return .success(.query(tool))

        case "trim_video":
            guard let start = parseTime(a["start"]), let end = parseTime(a["end"]) else { return bad("start/end") }
            guard start >= 0, end > start, start < canvas.duration else { return bad("range") }
            return op(.trim(start: start, end: min(end, canvas.duration)))

        case "adjust_speed":
            guard let speed = num("speed"), speed >= 0.25, speed <= 4 else { return bad("speed 0.25-4") }
            return op(.speed(speed))

        case "crop_video":
            guard let x = num("x"), let y = num("y"), let w = num("width"), let h = num("height") else { return bad("crop") }
            let (xi, yi, wi, hi) = (Int(x.rounded()), Int(y.rounded()), Int(w.rounded()), Int(h.rounded()))
            guard xi >= 0, yi >= 0, wi >= 2, hi >= 2, xi + wi <= canvas.width, yi + hi <= canvas.height else {
                return bad("crop outside \(canvas.width)x\(canvas.height)")
            }
            return op(.crop(x: xi, y: yi, width: wi, height: hi))

        case "rotate_video":
            guard let angle = num("angle"), abs(angle) <= 3600 else { return bad("angle") }
            return op(.rotate(degrees: angle))

        case "flip_video_horizontal":
            return op(.flipHorizontal)
        case "flip_video_vertical":
            return op(.flipVertical)

        case "resize_video":
            guard var w = num("width").map({ Int($0.rounded()) }), var h = num("height").map({ Int($0.rounded()) }) else {
                return bad("width/height")
            }
            if w < 0 && h < 0 || w == 0 || h == 0 { return bad("width/height") }
            if w < 0 { w = Int((Double(h) * Double(canvas.width) / Double(canvas.height)).rounded()) }
            if h < 0 { h = Int((Double(w) * Double(canvas.height) / Double(canvas.width)).rounded()) }
            guard w >= 2, h >= 2, w <= 8192, h <= 8192 else { return bad("size") }
            return op(.resize(width: w, height: h))

        case "resize_video_preset":
            guard let preset = a["preset"]?.stringValue, let size = presets[preset] else { return bad("preset") }
            return op(.pad(width: size.0, height: size.1))

        case "adjust_brightness":
            guard let v = num("brightness"), v >= -1, v <= 1 else { return bad("brightness -1..1") }
            return op(.colorControls(brightness: v, contrast: 1, saturation: 1))
        case "adjust_contrast":
            guard let v = num("contrast"), v >= 0, v <= 3 else { return bad("contrast 0..3") }
            return op(.colorControls(brightness: 0, contrast: v, saturation: 1))
        case "adjust_saturation":
            guard let v = num("saturation"), v >= 0, v <= 3 else { return bad("saturation 0..3") }
            return op(.colorControls(brightness: 0, contrast: 1, saturation: v))
        case "adjust_hue":
            guard let v = num("degrees"), abs(v) <= 360 else { return bad("degrees") }
            return op(.hue(degrees: v))

        case "apply_color_filter":
            guard var filter = a["filter"]?.stringValue?.lowercased()
                .replacingOccurrences(of: "-", with: "_").replacingOccurrences(of: " ", with: "_") else { return bad("filter") }
            switch filter {
            case "gray", "greyscale", "monochrome": filter = "grayscale"
            case "b&w", "bw": filter = "black_and_white"
            case "negative": filter = "invert"
            default: break
            }
            guard colorFilters.contains(filter) else { return bad("filter") }
            let intensity = a["intensity"] == nil || a["intensity"] == .null ? 1 : num("intensity")
            guard let intensity, intensity >= 0, intensity <= 1 else { return bad("intensity 0..1") }
            return op(.colorFilter(filter: filter, intensity: intensity))

        case "add_text":
            guard let text = a["text"]?.stringValue, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  text.count <= 500 else { return bad("text") }
            let x = num("x").map { Int($0.rounded()) } ?? 10
            let y = num("y").map { Int($0.rounded()) } ?? 10
            let size = num("fontsize").map { Int($0.rounded()) } ?? 24
            guard size >= 4, size <= 500 else { return bad("fontsize") }
            let colorName = a["color"]?.stringValue ?? "white"
            guard let color = RGBAColor.parse(colorName.isEmpty ? "white" : colorName) else { return bad("color") }
            return op(.text(text, x: x, y: y, fontSize: size, color: color))

        case "adjust_audio_volume":
            guard canvas.hasAudio else { return bad("no audio track") }
            guard let v = num("volume"), v >= 0, v <= 4 else { return bad("volume 0..4") }
            return op(.volume(v))

        case "audio_fade":
            guard canvas.hasAudio else { return bad("no audio track") }
            guard let type = a["type"]?.stringValue?.lowercased(), type == "in" || type == "out" else { return bad("type") }
            guard let d = num("duration"), d > 0 else { return bad("duration") }
            var start: Double?
            if a["start"] != nil, a["start"] != .null {
                guard let s = num("start"), s >= 0, s < canvas.duration else { return bad("start") }
                start = s
            }
            return op(.fade(isIn: type == "in", duration: min(d, canvas.duration), start: start))

        case "convert_video_format":
            guard let f = a["format"]?.stringValue?.lowercased() else { return bad("format") }
            guard f == "mp4" || f == "mov" else { return .failure(.unsupportedOnDevice) }
            return op(.outputFormat(f))

        case "convert_image_format":
            guard canvas.isPhoto else { return bad("photos only") }
            guard var f = a["format"]?.stringValue?.lowercased() else { return bad("format") }
            if f == "jpeg" { f = "jpg" }
            guard f == "jpg" || f == "png" else { return .failure(.unsupportedOnDevice) }
            return op(.outputFormat(f))

        default:
            return .failure(.unsupportedOnDevice)
        }
    }

    /// Seconds, or `[[HH:]MM:]SS[.ms]`, from a number or string.
    static func parseTime(_ value: JSONValue?) -> Double? {
        guard let value else { return nil }
        if let d = value.doubleValue { return d.isFinite ? d : nil }
        guard let s = value.stringValue?.trimmingCharacters(in: .whitespaces), !s.isEmpty else { return nil }
        let parts = s.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard parts.count <= 3 else { return nil }
        var total = 0.0
        for part in parts {
            guard let v = Double(part), v >= 0 else { return nil }
            total = total * 60 + v
        }
        return total
    }
}
