import CoreMedia
import Foundation

/// Compatibility adapter between the single-clip `EditStack` and the timeline model.
///
/// - A legacy stack becomes a one-clip project: timeline ops (trim/speed) fold into the
///   clip's source range and speed, frame ops become that clip's effects, volume/fades
///   become its original-audio settings, a `.soundtrack` op becomes a normal clip on a
///   "Soundtrack" music track (movable/trimmable/removable like any other audio clip),
///   and the stack's final-timeline captions become project-time captions.
/// - `EditStack.isTimelineProject` marks stacks whose preview/export must be composed
///   from `EditStack.project` instead of the single-source path: any project with more
///   than one video clip or any audio track. A one-clip project with no audio tracks
///   keeps the original composer path bit-for-bit.
///
/// Tradeoff, recorded deliberately: lyric captions migrate as project captions using
/// each line's combined display text (original + translation). Timing is preserved; the
/// dedicated two-line lyric renderer is not used for migrated projects.
extension EditStack {
    /// Builds the equivalent one-clip project. `resolveRelativePath` maps an absolute
    /// media URL to the path stored on its asset (ProjectStore supplies real relative
    /// paths for durable projects; the default keeps the last path component, which is
    /// enough for in-memory preview/export sessions).
    func makeProject(
        name: String = "Untitled",
        resolveRelativePath: (URL) -> String = { $0.lastPathComponent }
    ) -> EditorProject {
        let baseAsset = MediaAsset(
            id: UUID(), relativePath: resolveRelativePath(base), name: base.lastPathComponent,
            mediaType: baseCanvas.isPhoto ? .image : .video,
            duration: .seconds(baseCanvas.duration),
            naturalSize: CodableSize(width: Double(baseCanvas.width), height: Double(baseCanvas.height)),
            preferredTransform: .identity, nominalFrameRate: 0, hasAudio: baseCanvas.hasAudio)

        var clip = VideoClip(
            id: UUID(), assetID: baseAsset.id,
            sourceStart: .zero, sourceEnd: .seconds(baseCanvas.duration),
            originalAudioEnabled: baseCanvas.hasAudio)
        var canvasWidth = baseCanvas.width
        var canvasHeight = baseCanvas.height
        var soundtrackOp: (file: URL, startOffset: Double, originalVolume: Double)?

        for op in ops {
            switch op {
            case .trim(let start, let end):
                // `start`/`end` are on the timeline as it stood when the op was applied;
                // map through the speed accumulated so far.
                let s = clip.sourceStart.seconds + start * clip.speed
                let e = clip.sourceStart.seconds + end * clip.speed
                clip.sourceStart = .seconds(max(0, s))
                clip.sourceEnd = .seconds(max(s + 0.01, e))
            case .speed(let factor):
                clip.speed *= factor
            case .volume(let gain):
                clip.audioGain *= gain
            case .fade(let isIn, let duration, _):
                if isIn { clip.audioFadeIn = duration } else { clip.audioFadeOut = duration }
            case .soundtrack(let file, let startOffset, let originalVolume):
                soundtrackOp = (file, startOffset, originalVolume)
            case .resize(let w, let h), .pad(let w, let h):
                canvasWidth = w; canvasHeight = h
            case .crop(let x, let y, let w, let h):
                clip.effects.append(.crop(x: x, y: y, width: w, height: h))
            case .rotate(let degrees):
                clip.effects.append(.rotate(degrees: degrees))
            case .flipHorizontal:
                clip.effects.append(.flipHorizontal)
            case .flipVertical:
                clip.effects.append(.flipVertical)
            case .colorControls(let b, let c, let s):
                clip.effects.append(.colorControls(brightness: b, contrast: c, saturation: s))
            case .hue(let degrees):
                clip.effects.append(.hue(degrees: degrees))
            case .colorFilter(let filter, let intensity):
                clip.effects.append(.colorFilter(filter: filter, intensity: intensity))
            case .text(let text, let x, let y, let fontSize, _):
                clip.effects.append(.text(text: text, x: x, y: y, fontSize: fontSize, color: "white"))
            case .outputFormat, .captions, .lyricCaptions:
                break
            }
        }

        var project = EditorProject(
            name: name,
            canvas: ProjectCanvas(width: max(2, canvasWidth), height: max(2, canvasHeight)))
        project.assets = [baseAsset]
        if !baseCanvas.isPhoto { project.videoClips = [clip] }
        project.selectedClipID = clip.id
        project.captions = captionCues
        if project.captions.isEmpty, let lyric = lyricTrack {
            project.captions = lyric.lines.map {
                CaptionCue(start: $0.start, end: $0.end, text: $0.displayText)
            }
        }

        if let soundtrackOp {
            // The fetched soundtrack becomes a first-class audio clip. Its asset duration
            // is stated as startOffset + project duration (the composer clamps to the
            // real file when it loads it); `originalVolume` folds into the video clip's
            // gain exactly as the legacy mix applied it (0 = original replaced, which
            // the enabled flag expresses directly).
            let songAsset = MediaAsset(
                id: UUID(), relativePath: resolveRelativePath(soundtrackOp.file),
                name: soundtrackOp.file.lastPathComponent, mediaType: .audio,
                duration: .seconds(soundtrackOp.startOffset + max(1, project.durationSeconds)),
                naturalSize: CodableSize(width: 0, height: 0), preferredTransform: .identity,
                nominalFrameRate: 0, hasAudio: true)
            let songClip = AudioClip(
                id: UUID(), assetID: songAsset.id,
                sourceStart: .seconds(soundtrackOp.startOffset),
                sourceDuration: .seconds(max(1, project.durationSeconds)),
                timelineStart: .zero, gain: 1)
            var track = AudioTrack(id: UUID(), name: "Soundtrack", kind: .music)
            track.clips = [songClip]
            project.assets.append(songAsset)
            project.audioTracks = [track]
            if !project.videoClips.isEmpty {
                if soundtrackOp.originalVolume <= 0 {
                    project.videoClips[0].originalAudioEnabled = false
                } else {
                    project.videoClips[0].audioGain = clip.audioGain * soundtrackOp.originalVolume
                }
            }
        }
        return project
    }
}
