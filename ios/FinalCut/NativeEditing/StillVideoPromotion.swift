import Foundation

/// Duration and routing for turning a photo into a still video so timeline
/// edits (captions, soundtrack, trim, …) can run. The promotion is a rebase
/// on the edit stack; undo returns to the original photo.
enum StillVideoPromotion {
    static let defaultDuration: Double = 10

    /// `requested` if it is a positive finite duration, else a positive
    /// `soundtrackLength`, else 10 seconds.
    static func duration(requested: Double?, soundtrackLength: Double? = nil) -> Double {
        if let requested, requested.isFinite, requested > 0 { return requested }
        if let soundtrackLength, soundtrackLength.isFinite, soundtrackLength > 0 {
            return soundtrackLength
        }
        return defaultDuration
    }

    /// Duration implied by the tool call, if any.
    ///
    /// For `trim_video`, the still video must last until `end` so the trim
    /// range is valid; otherwise `duration_seconds` / `duration` win.
    static func requestedDuration(tool: String, arguments: [String: JSONValue]) -> Double? {
        func num(_ key: String) -> Double? {
            guard let v = arguments[key] else { return nil }
            if let d = v.doubleValue, d.isFinite { return d }
            if let s = v.stringValue,
               let d = Double(s.trimmingCharacters(in: .whitespaces)), d.isFinite {
                return d
            }
            return nil
        }
        let name = ToolCatalog.canonicalName(tool)
        if name == "trim_video" {
            let start = num("start") ?? 0
            if let end = num("end"), end > start { return end }
        }
        if let seconds = num("duration_seconds"), seconds > 0 { return seconds }
        if let seconds = num("duration"), seconds > 0 { return seconds }
        return nil
    }

    /// Video-only (or caption / soundtrack) edits that need a timeline.
    /// Frame-only photo tools and the FFmpeg fallback do not convert.
    static func needsStillVideo(tool: String) -> Bool {
        let name = ToolCatalog.canonicalName(tool)
        if NativeToolParser.photoTools.contains(name) { return false }
        if name == "ffmpeg_cli" { return false }
        return ToolCatalog.isKnown(name) || NativeToolParser.isSupported(name)
    }
}
