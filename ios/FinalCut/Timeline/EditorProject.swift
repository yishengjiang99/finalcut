import CoreGraphics
import CoreMedia
import Foundation

// MARK: - Codable media primitives
//
// CMTime / CGSize / CGAffineTransform are not Codable. Project files are JSON, so every
// time and geometry value in the timeline model is stored in one of these wrappers and
// converted at the composition boundary. All composition math is done in CMTime (value /
// timescale), never by accumulating rounded Double seconds.

/// CMTime stored as value + timescale (exact, no rounding).
struct CodableTime: Codable, Equatable, Hashable, Sendable {
    var value: Int64
    var timescale: Int32

    init(_ time: CMTime) {
        value = time.value
        timescale = time.timescale == 0 ? 600 : time.timescale
    }

    init(value: Int64, timescale: Int32) {
        self.value = value
        self.timescale = timescale == 0 ? 600 : timescale
    }

    init(seconds: Double, timescale: Int32 = 600) {
        let time = CMTime(seconds: seconds, preferredTimescale: timescale)
        value = time.value
        self.timescale = time.timescale == 0 ? timescale : time.timescale
    }

    var cmTime: CMTime { CMTime(value: value, timescale: timescale) }
    var seconds: Double { CMTimeGetSeconds(cmTime) }

    static let zero = CodableTime(value: 0, timescale: 600)
    static func seconds(_ s: Double) -> CodableTime { CodableTime(seconds: s) }
}

struct CodableSize: Codable, Equatable, Sendable {
    var width: Double
    var height: Double
    init(_ size: CGSize) { width = Double(size.width); height = Double(size.height) }
    init(width: Double, height: Double) { self.width = width; self.height = height }
    var cgSize: CGSize { CGSize(width: width, height: height) }
}

struct CodableTransform: Codable, Equatable, Sendable {
    var a: Double, b: Double, c: Double, d: Double, tx: Double, ty: Double
    init(_ t: CGAffineTransform) {
        a = Double(t.a); b = Double(t.b); c = Double(t.c); d = Double(t.d); tx = Double(t.tx); ty = Double(t.ty)
    }
    init(a: Double, b: Double, c: Double, d: Double, tx: Double, ty: Double) {
        self.a = a; self.b = b; self.c = c; self.d = d; self.tx = tx; self.ty = ty
    }
    var cgTransform: CGAffineTransform { CGAffineTransform(a: CGFloat(a), b: CGFloat(b), c: CGFloat(c), d: CGFloat(d), tx: CGFloat(tx), ty: CGFloat(ty)) }
    static let identity = CodableTransform(.identity)
}

enum ProjectMediaType: String, Codable, Sendable {
    case video, audio, image
}

// MARK: - Assets

/// One imported original, stored once under the project's Media directory. Timeline clips
/// reference it by `id`; the file itself is never modified by an edit.
struct MediaAsset: Codable, Equatable, Sendable, Identifiable {
    var id: UUID
    /// Path relative to the project directory (e.g. "Media/<asset-id>.mov").
    var relativePath: String
    /// Display name (original file name at import; metadata only, never used as a key).
    var name: String
    var mediaType: ProjectMediaType
    var duration: CodableTime
    var naturalSize: CodableSize
    var preferredTransform: CodableTransform
    var nominalFrameRate: Float
    var hasAudio: Bool
}

/// A frame effect that can be attached to ONE video clip (or, via a command, to all clips).
/// Mirrors the frame subset of `NativeOp` so a per-clip chain can be replayed by
/// `FrameRenderer` without touching other clips.
enum ClipEffect: Codable, Equatable, Sendable {
    case colorControls(brightness: Double, contrast: Double, saturation: Double)
    case hue(degrees: Double)
    case colorFilter(filter: String, intensity: Double)
    case crop(x: Int, y: Int, width: Int, height: Int)
    case rotate(degrees: Double)
    case flipHorizontal
    case flipVertical
    case text(text: String, x: Int, y: Int, fontSize: Int, color: String)

    var nativeOp: NativeOp {
        switch self {
        case .colorControls(let b, let c, let s): return .colorControls(brightness: b, contrast: c, saturation: s)
        case .hue(let d): return .hue(degrees: d)
        case .colorFilter(let f, let i): return .colorFilter(filter: f, intensity: i)
        case .crop(let x, let y, let w, let h): return .crop(x: x, y: y, width: w, height: h)
        case .rotate(let d): return .rotate(degrees: d)
        case .flipHorizontal: return .flipHorizontal
        case .flipVertical: return .flipVertical
        case .text(let t, let x, let y, let size, let color):
            return .text(t, x: x, y: y, fontSize: size, color: RGBAColor.parse(color) ?? .white)
        }
    }
}

enum TransitionKind: String, Codable, Sendable {
    case cut, crossDissolve, fadeThroughBlack
}

/// Transition OUT of a clip into the next one. Non-cut transitions overlap the two clips
/// by `duration` (clamped to half of each neighbour at layout time); project duration
/// shrinks by the overlap so audio and captions stay on the same project clock.
struct TransitionSpec: Codable, Equatable, Sendable {
    var kind: TransitionKind
    var duration: CodableTime
    static let cut = TransitionSpec(kind: .cut, duration: .zero)
}

// MARK: - Video clips

/// One segment on the primary (sequential) video track. Its project position is DERIVED
/// from the order of `EditorProject.videoClips` — clips on this track cannot overlap by
/// construction, and reordering a clip automatically moves its original audio with it.
struct VideoClip: Codable, Equatable, Sendable, Identifiable {
    var id: UUID
    var assetID: UUID
    /// Source range in the asset's own time (seconds-exact CMTime).
    var sourceStart: CodableTime
    var sourceEnd: CodableTime
    var speed: Double = 1
    /// Original camera audio attached to this clip.
    var originalAudioEnabled: Bool = true
    var audioGain: Double = 1
    var audioFadeIn: Double = 0
    var audioFadeOut: Double = 0
    var effects: [ClipEffect] = []
    var transitionOut: TransitionSpec = .cut
    /// Captions in SOURCE time, attached to the asset range (they follow trim/split/speed
    /// through the explicit mapping in `EditorProject.projectCaptions()`).
    var captions: [CaptionCue] = []

    var sourceDuration: CMTime { CMTimeSubtract(sourceEnd.cmTime, sourceStart.cmTime) }
    /// Duration on the project timeline (source duration / speed).
    var outputDuration: CMTime {
        guard speed > 0 else { return sourceDuration }
        return CMTimeMultiplyByFloat64(sourceDuration, multiplier: 1 / speed)
    }
}

// MARK: - Audio tracks and clips

enum AudioTrackKind: String, Codable, Sendable {
    case music, voiceover, effects, other
}

/// One point of stored gain automation (project time relative to the clip's start).
struct GainPoint: Codable, Equatable, Sendable {
    var time: CodableTime
    var gain: Double
}

/// One audio segment placed freely on the project timeline. Clips may overlap — within a
/// track and across tracks — and are mixed by the composer.
struct AudioClip: Codable, Equatable, Sendable, Identifiable {
    var id: UUID
    var assetID: UUID
    var sourceStart: CodableTime
    /// Length of source audio used (before looping).
    var sourceDuration: CodableTime
    var timelineStart: CodableTime
    var gain: Double = 1
    var muted: Bool = false
    var fadeIn: Double = 0
    var fadeOut: Double = 0
    /// Repeat the source range until `repeatUntil` (project time) or the project end.
    var loop: Bool = false
    var repeatUntil: CodableTime?
    /// Ducking / manual automation, clip-local times, gains already combined at apply time.
    var automation: [GainPoint] = []

    /// Length on the project timeline.
    func outputDuration(projectEnd: CMTime) -> CMTime {
        if loop {
            let end = repeatUntil?.cmTime ?? projectEnd
            let length = CMTimeSubtract(end, timelineStart.cmTime)
            return length > .zero ? length : sourceDuration.cmTime
        }
        return sourceDuration.cmTime
    }
    var placedDuration: CMTime {
        // Without a project end, a looping clip reports one pass; the composer passes the
        // real project end when it lays tracks out.
        outputDuration(projectEnd: timelineStart.cmTime + sourceDuration.cmTime)
    }
}

struct AudioTrack: Codable, Equatable, Sendable, Identifiable {
    var id: UUID
    var name: String
    var kind: AudioTrackKind
    /// Track gain multiplies each clip's gain exactly once (clip gain × track gain,
    /// applied a single time in the audio mix — never both in two places).
    var gain: Double = 1
    var muted: Bool = false
    var clips: [AudioClip] = []
}

// MARK: - Canvas

enum CanvasFit: String, Codable, Sendable {
    /// Letter/pillar-box, never distort (default; matches the single-clip `pad` behaviour).
    case aspectFit
    /// Fill the canvas, cropping the overflow.
    case aspectFill
}

struct ProjectCanvas: Codable, Equatable, Sendable {
    var width: Int
    var height: Int
    var fit: CanvasFit = .aspectFit
    var cgSize: CGSize { CGSize(width: width, height: height) }
    static let hd1080Landscape = ProjectCanvas(width: 1920, height: 1080)
}

// MARK: - Project

struct EditorProject: Codable, Equatable, Sendable {
    static let currentSchemaVersion = 1

    var id: UUID
    var name: String
    var canvas: ProjectCanvas
    var assets: [MediaAsset] = []
    var videoClips: [VideoClip] = []
    var audioTracks: [AudioTrack] = []
    var selectedClipID: UUID?
    var selectedAudioClipID: UUID?
    /// Monotonic edit counter (the server contract's project revision): incremented
    /// once per applied mutation (a batch counts once), including undo/redo. Models
    /// plan against a revision and the executor rejects stale plans with
    /// `project_revision_conflict`. Persisted with the project.
    var revision: Int = 0
    /// Captions already on PROJECT time (e.g. migrated from a single-clip EditStack).
    var captions: [CaptionCue] = []
    var schemaVersion: Int = EditorProject.currentSchemaVersion

    init(id: UUID = UUID(), name: String = "Untitled", canvas: ProjectCanvas) {
        self.id = id
        self.name = name
        self.canvas = canvas
    }

    // Lookups -------------------------------------------------------------

    func asset(_ id: UUID) -> MediaAsset? { assets.first { $0.id == id } }
    func clip(_ id: UUID) -> VideoClip? { videoClips.first { $0.id == id } }
    func clipIndex(_ id: UUID) -> Int? { videoClips.firstIndex { $0.id == id } }
    func audioTrack(_ id: UUID) -> AudioTrack? { audioTracks.first { $0.id == id } }
    func audioClip(_ id: UUID) -> (track: AudioTrack, clip: AudioClip)? {
        for track in audioTracks {
            if let clip = track.clips.first(where: { $0.id == id }) { return (track, clip) }
        }
        return nil
    }

    // Layout -------------------------------------------------------------
    //
    // Three time bases, kept distinct everywhere:
    //   source time  — inside an asset file
    //   clip-local   — source time mapped through the clip's trim + speed
    //   project time — clip-local offset by the clip's layout start

    struct ClipLayout: Equatable, Sendable {
        var clipID: UUID
        var start: CMTime
        var duration: CMTime
        var end: CMTime { CMTimeAdd(start, duration) }
        /// Overlap with the PREVIOUS clip caused by its transitionOut (0 for cuts).
        var overlapWithPrevious: CMTime
    }

    /// Overlap a transition creates between clip `index` and clip `index + 1`.
    func transitionOverlap(after index: Int) -> CMTime {
        guard index >= 0, index + 1 < videoClips.count else { return .zero }
        let spec = videoClips[index].transitionOut
        guard spec.kind != .cut, spec.duration.cmTime > .zero else { return .zero }
        let halfPrev = CMTimeMultiplyByFloat64(videoClips[index].outputDuration, multiplier: 0.5)
        let halfNext = CMTimeMultiplyByFloat64(videoClips[index + 1].outputDuration, multiplier: 0.5)
        var overlap = spec.duration.cmTime
        if overlap > halfPrev { overlap = halfPrev }
        if overlap > halfNext { overlap = halfNext }
        return overlap > .zero ? overlap : .zero
    }

    var layout: [ClipLayout] {
        var result: [ClipLayout] = []
        var cursor = CMTime.zero
        for (index, clip) in videoClips.enumerated() {
            let overlap = index == 0 ? CMTime.zero : transitionOverlap(after: index - 1)
            let start = index == 0 ? CMTime.zero : CMTimeSubtract(cursor, overlap)
            let duration = clip.outputDuration
            result.append(ClipLayout(clipID: clip.id, start: start, duration: duration, overlapWithPrevious: overlap))
            cursor = CMTimeAdd(start, duration)
        }
        return result
    }

    /// Derived, never stored: the arrangement defines the duration (invariant 10).
    var duration: CMTime { layout.last?.end ?? .zero }
    var durationSeconds: Double { CMTimeGetSeconds(duration) }

    func layout(for clipID: UUID) -> ClipLayout? { layout.first { $0.clipID == clipID } }

    /// Project time → (clip, source time), or nil outside every clip.
    func sourceTime(atProjectTime time: CMTime) -> (clip: VideoClip, sourceTime: CMTime)? {
        for entry in layout {
            guard let clip = clip(entry.clipID) else { continue }
            if time >= entry.start, time < entry.end {
                let local = CMTimeSubtract(time, entry.start)
                let source = CMTimeAdd(clip.sourceStart.cmTime, CMTimeMultiplyByFloat64(local, multiplier: clip.speed))
                return (clip, source)
            }
        }
        return nil
    }

    /// All captions on project time: per-clip source captions mapped through trim/speed/
    /// layout, merged with project-level captions, sorted, never duplicated.
    func projectCaptions() -> [CaptionCue] {
        var mapped: [CaptionCue] = captions
        for entry in layout {
            guard let clip = clip(entry.clipID) else { continue }
            for cue in clip.captions {
                let s = max(cue.start, clip.sourceStart.seconds)
                let e = min(cue.end, clip.sourceEnd.seconds)
                guard e - s > 0.05 else { continue }
                let start = CMTimeGetSeconds(entry.start) + (s - clip.sourceStart.seconds) / max(clip.speed, 0.0001)
                let end = CMTimeGetSeconds(entry.start) + (e - clip.sourceStart.seconds) / max(clip.speed, 0.0001)
                mapped.append(CaptionCue(start: start, end: end, text: cue.text))
            }
        }
        return mapped.sorted { $0.start < $1.start }
    }

    // Validation -----------------------------------------------------------

    enum ValidationError: Error, Equatable {
        case issues([String])
        var codes: [String] {
            switch self { case .issues(let codes): return codes }
        }
    }

    /// Stable, machine-readable issue codes (also surfaced to the model as tool errors).
    func validationIssues() -> [String] {
        var issues: [String] = []
        if canvas.width < 2 || canvas.height < 2 { issues.append("canvas_too_small") }
        var assetIDs = Set<UUID>()
        for asset in assets {
            if !assetIDs.insert(asset.id).inserted { issues.append("duplicate_asset_id") }
            if asset.relativePath.isEmpty { issues.append("asset_missing_path") }
            if asset.mediaType != .image, asset.duration.cmTime < .zero { issues.append("asset_negative_duration") }
        }
        var clipIDs = Set<UUID>()
        for clip in videoClips {
            if !clipIDs.insert(clip.id).inserted { issues.append("duplicate_clip_id") }
            // Asset-independent checks run first so a clip whose asset is missing
            // still reports its other problems (bad speed, gain, fades, range).
            if clip.sourceDuration <= .zero { issues.append("clip_nonpositive_duration") }
            if clip.sourceStart.cmTime < .zero { issues.append("clip_negative_start") }
            if !(0.05...16).contains(clip.speed) { issues.append("clip_speed_out_of_range") }
            if !(0...4).contains(clip.audioGain) { issues.append("clip_gain_out_of_range") }
            if clip.audioFadeIn < 0 || clip.audioFadeOut < 0 { issues.append("clip_negative_fade") }
            guard let asset = asset(clip.assetID) else { issues.append("clip_missing_asset"); continue }
            if asset.mediaType == .video, clip.sourceEnd.cmTime > asset.duration.cmTime + CMTime(seconds: 0.05, preferredTimescale: 600) {
                issues.append("clip_range_exceeds_asset")
            }
        }
        var audioIDs = Set<UUID>()
        for track in audioTracks {
            if !(0...4).contains(track.gain) { issues.append("track_gain_out_of_range") }
            for clip in track.clips {
                if !audioIDs.insert(clip.id).inserted { issues.append("duplicate_audio_clip_id") }
                guard asset(clip.assetID) != nil else { issues.append("audio_clip_missing_asset"); continue }
                if clip.sourceDuration.cmTime <= .zero { issues.append("audio_clip_nonpositive_duration") }
                if clip.timelineStart.cmTime < .zero { issues.append("audio_clip_negative_start") }
                if clip.sourceStart.cmTime < .zero { issues.append("audio_clip_negative_source_start") }
                if !(0...4).contains(clip.gain) { issues.append("audio_clip_gain_out_of_range") }
                if clip.fadeIn < 0 || clip.fadeOut < 0 { issues.append("audio_clip_negative_fade") }
                if let until = clip.repeatUntil, until.cmTime <= clip.timelineStart.cmTime {
                    issues.append("audio_clip_loop_end_before_start")
                }
            }
        }
        if let selected = selectedClipID, clip(selected) == nil { issues.append("selected_clip_missing") }
        return issues
    }

    func validateOrThrow() throws {
        let issues = validationIssues()
        if !issues.isEmpty { throw ValidationError.issues(issues) }
    }

    var isValid: Bool { validationIssues().isEmpty }

    // Model-facing summary ---------------------------------------------------

    /// Bounded, metadata-only project summary for the client-mode chat request.
    /// No media bytes, no file paths — IDs, order, ranges and gains only.
    func summary() -> ProjectSummary {
        let entries = layout
        return ProjectSummary(
            projectID: id.uuidString,
            revision: revision,
            schemaVersion: schemaVersion,
            canvasWidth: canvas.width,
            canvasHeight: canvas.height,
            durationSeconds: (durationSeconds * 1000).rounded() / 1000,
            selectedClipID: selectedClipID?.uuidString,
            selectedAudioClipID: selectedAudioClipID?.uuidString,
            assets: assets.map {
                ProjectSummary.Asset(id: $0.id.uuidString, name: $0.name, mediaType: $0.mediaType.rawValue,
                                     durationSeconds: ($0.duration.seconds * 1000).rounded() / 1000, hasAudio: $0.hasAudio)
            },
            videoClips: videoClips.map { clip in
                let entry = entries.first { $0.clipID == clip.id }
                return ProjectSummary.VideoClip(
                    id: clip.id.uuidString, assetID: clip.assetID.uuidString,
                    timelineStartSeconds: entry.map { ($0.start.seconds * 1000).rounded() / 1000 } ?? 0,
                    sourceStartSeconds: (clip.sourceStart.seconds * 1000).rounded() / 1000,
                    sourceEndSeconds: (clip.sourceEnd.seconds * 1000).rounded() / 1000,
                    speed: clip.speed, originalAudioEnabled: clip.originalAudioEnabled,
                    audioGain: clip.audioGain, effectCount: clip.effects.count,
                    transitionOut: clip.transitionOut.kind.rawValue)
            },
            audioTracks: audioTracks.map { track in
                ProjectSummary.AudioTrack(
                    id: track.id.uuidString, name: track.name, kind: track.kind.rawValue,
                    gain: track.gain, muted: track.muted,
                    clips: track.clips.map {
                        ProjectSummary.AudioClip(
                            id: $0.id.uuidString, assetID: $0.assetID.uuidString,
                            timelineStartSeconds: ($0.timelineStart.seconds * 1000).rounded() / 1000,
                            sourceStartSeconds: ($0.sourceStart.seconds * 1000).rounded() / 1000,
                            sourceDurationSeconds: ($0.sourceDuration.seconds * 1000).rounded() / 1000,
                            gain: $0.gain, muted: $0.muted, fadeIn: $0.fadeIn, fadeOut: $0.fadeOut, loop: $0.loop)
                    })
            })
    }
}

/// Codable summary sent to the model (client-mode `media.project`).
struct ProjectSummary: Codable, Equatable, Sendable {
    struct Asset: Codable, Equatable, Sendable {
        var id: String; var name: String; var mediaType: String; var durationSeconds: Double; var hasAudio: Bool
    }
    struct VideoClip: Codable, Equatable, Sendable {
        var id: String; var assetID: String; var timelineStartSeconds: Double
        var sourceStartSeconds: Double; var sourceEndSeconds: Double
        var speed: Double; var originalAudioEnabled: Bool; var audioGain: Double
        var effectCount: Int; var transitionOut: String
    }
    struct AudioClip: Codable, Equatable, Sendable {
        var id: String; var assetID: String; var timelineStartSeconds: Double
        var sourceStartSeconds: Double; var sourceDurationSeconds: Double
        var gain: Double; var muted: Bool; var fadeIn: Double; var fadeOut: Double; var loop: Bool
    }
    struct AudioTrack: Codable, Equatable, Sendable {
        var id: String; var name: String; var kind: String; var gain: Double; var muted: Bool
        var clips: [AudioClip]
    }
    var projectID: String
    var revision: Int
    var schemaVersion: Int
    var canvasWidth: Int
    var canvasHeight: Int
    var durationSeconds: Double
    var selectedClipID: String?
    var selectedAudioClipID: String?
    var assets: [Asset]
    var videoClips: [VideoClip]
    var audioTracks: [AudioTrack]
    /// Timeline playhead (project seconds). View state, not project state: `summary()`
    /// leaves it nil and the editor fills it in for the chat request.
    var playheadSeconds: Double?
}
