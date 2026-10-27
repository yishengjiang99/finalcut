import AVFoundation
import CoreImage
import CoreMedia
import Foundation

/// Multi-clip composition engine (Phase B/C). Builds ONE `AVMutableComposition` from a
/// whole `EditorProject`:
///
/// - Video: clips are inserted sequentially at their layout positions (source range,
///   then the composition track is time-scaled for the clip's speed). With a non-cut
///   transition, neighbouring clips alternate between two composition tracks so their
///   ranges genuinely overlap; `ProjectVideoCompositor` blends them.
/// - Per-clip orientation: every segment keeps its own preferred transform; frames are
///   normalised, run through that clip's `FrameRenderer` effect chain, then fitted
///   (aspectFit / aspectFill) into the project canvas. The first clip's transform is
///   never applied to the whole project.
/// - Original audio: one composition track per video clip, same range + same time
///   scaling, so camera audio cannot drift from its picture.
/// - Independent audio: logical tracks are packed onto as many composition tracks as
///   overlapping clips require; each clip contributes its own gain/fades/automation
///   ramps (clip gain × track gain, applied exactly once, in the audio mix).
///
/// The same `ComposedVideo` feeds preview (`AVPlayerItem`) and export
/// (`AVAssetExportSession`), so the two cannot diverge in timing or levels.
enum ProjectComposerError: Error {
    case invalidProject([String])
    case missingAsset(UUID)
    case noVideoTrack(UUID)
    case noAudioTrack(UUID)
}

extension NativeComposer {
    /// Resolves a stored asset to a file URL: the durable ProjectStore location first,
    /// then an absolute path (in-memory adapter projects), then the store path anyway
    /// (so the load error names the expected durable location).
    static func resolveAssetURL(_ asset: MediaAsset, in project: EditorProject) -> URL {
        let stored = ProjectStore.resolve(asset, in: project)
        if FileManager.default.fileExists(atPath: stored.path) { return stored }
        if asset.relativePath.hasPrefix("/") { return URL(fileURLWithPath: asset.relativePath) }
        return stored
    }

    static func compose(project: EditorProject) async throws -> ComposedVideo {
        try compose(project: project, resolve: { resolveAssetURL($0, in: project) })
    }

    static func compose(project: EditorProject, resolve: (MediaAsset) -> URL) async throws -> ComposedVideo {
        let issues = project.validationIssues()
        if !issues.isEmpty { throw ProjectComposerError.invalidProject(issues) }
        let timescale = NativeComposer.timescale
        let composition = AVMutableComposition()
        let layout = project.layout
        let projectEnd = project.duration
        let hasTransitions = layout.contains { $0.overlapWithPrevious > .zero }

        // MARK: Video segments
        var videoTracks: [AVMutableCompositionTrack] = []
        func videoTrack(at index: Int) -> AVMutableCompositionTrack? {
            if !hasTransitions {
                if videoTracks.isEmpty {
                    videoTracks.append(composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!)
                }
                return videoTracks[0]
            }
            while videoTracks.count <= index % 2 {
                videoTracks.append(composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!)
            }
            return videoTracks[index % 2]
        }

        var visuals: [UUID: ProjectSegmentVisual] = [:]
        // Descriptors for the audio mix, built alongside the tracks they describe.
        struct AudioLane {
            var track: AVMutableCompositionTrack
            var clips: [(start: CMTime, end: CMTime, gain: Float, fadeIn: Double, fadeOut: Double, automation: [GainPoint])]
        }
        var audioLanes: [AudioLane] = []
        func appendAudio(_ laneClip: (start: CMTime, end: CMTime, gain: Float, fadeIn: Double, fadeOut: Double, automation: [GainPoint]), to track: AVMutableCompositionTrack) {
            if let index = audioLanes.firstIndex(where: { $0.track === track }) {
                audioLanes[index].clips.append(laneClip)
            } else {
                audioLanes.append(AudioLane(track: track, clips: [laneClip]))
            }
        }

        for (index, entry) in layout.enumerated() {
            guard let clip = project.clip(entry.clipID), let asset = project.asset(clip.assetID) else {
                throw ProjectComposerError.missingAsset(project.videoClips[index].assetID)
            }
            let source = AVURLAsset(url: resolve(asset))
            guard let sourceVideo = try await source.loadTracks(withMediaType: .video).first else {
                throw ProjectComposerError.noVideoTrack(asset.id)
            }
            let (naturalSize, transform) = try await sourceVideo.load(.naturalSize, .preferredTransform)
            let orientedRect = CGRect(origin: .zero, size: naturalSize).applying(transform)
            let orientedSize = CGSize(width: abs(orientedRect.width), height: abs(orientedRect.height))
            guard let track = videoTrack(at: index) else { throw ProjectComposerError.noVideoTrack(asset.id) }
            let sourceRange = CMTimeRange(start: clip.sourceStart.cmTime, duration: clip.sourceDuration)
            try track.insertTimeRange(sourceRange, of: sourceVideo, at: entry.start)
            if abs(clip.speed - 1) > 0.0001 {
                track.scaleTimeRange(CMTimeRange(start: entry.start, duration: clip.sourceDuration), toDuration: entry.duration)
            }
            visuals[clip.id] = ProjectSegmentVisual(
                trackID: track.trackID,
                renderer: FrameRenderer(ops: clip.effects.map(\.nativeOp), sourceSize: orientedSize),
                naturalSize: naturalSize, transform: transform, orientedSize: orientedSize)

            // Original camera audio follows the clip (same range, same scaling).
            if clip.originalAudioEnabled, asset.hasAudio,
               let sourceAudio = try await source.loadTracks(withMediaType: .audio).first {
                let audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
                if let audioTrack {
                    try audioTrack.insertTimeRange(sourceRange, of: sourceAudio, at: entry.start)
                    if abs(clip.speed - 1) > 0.0001 {
                        audioTrack.scaleTimeRange(CMTimeRange(start: entry.start, duration: clip.sourceDuration), toDuration: entry.duration)
                    }
                    appendAudio((start: entry.start, end: entry.end, gain: Float(clip.audioGain),
                                 fadeIn: clip.audioFadeIn, fadeOut: clip.audioFadeOut, automation: []), to: audioTrack)
                }
            }
        }

        // MARK: Independent audio tracks (greedy lane packing per logical track)
        for logicalTrack in project.audioTracks where !logicalTrack.clips.isEmpty {
            var lanes: [(track: AVMutableCompositionTrack, busyUntil: CMTime)] = []
            for clip in logicalTrack.clips.sorted(by: { $0.timelineStart.cmTime < $1.timelineStart.cmTime }) {
                guard let asset = project.asset(clip.assetID) else { throw ProjectComposerError.missingAsset(clip.assetID) }
                let source = AVURLAsset(url: resolve(asset))
                guard let sourceAudio = try await source.loadTracks(withMediaType: .audio).first else {
                    throw ProjectComposerError.noAudioTrack(asset.id)
                }
                let start = clip.timelineStart.cmTime
                // Audio never extends the project: a 60s song under a 23s timeline is
                // clamped to the project end (its fade-out then lands on the real end),
                // it does not stretch the composition to 60s.
                let end = CMTimeMinimum(CMTimeAdd(start, clip.outputDuration(projectEnd: projectEnd)), projectEnd)
                guard end > start else { continue }
                // First lane free at `start`, else a new composition track.
                let laneIndex: Int
                if let free = lanes.firstIndex(where: { $0.busyUntil <= start }) {
                    laneIndex = free
                    lanes[free].busyUntil = end
                } else {
                    guard let newTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { continue }
                    lanes.append((track: newTrack, busyUntil: end))
                    laneIndex = lanes.count - 1
                }
                let lane = lanes[laneIndex].track
                // Insert one pass, or repeat the source range for a looping clip.
                var cursor = start
                var pass = 0
                while cursor < end {
                    let remaining = CMTimeSubtract(end, cursor)
                    let passDuration = CMTimeMinimum(clip.sourceDuration.cmTime, remaining)
                    guard passDuration > .zero else { break }
                    try lane.insertTimeRange(
                        CMTimeRange(start: clip.sourceStart.cmTime, duration: passDuration),
                        of: sourceAudio, at: cursor)
                    cursor = CMTimeAdd(cursor, passDuration)
                    pass += 1
                    if !clip.loop || pass > 10_000 { break }
                }
                let combinedGain = logicalTrack.muted || clip.muted ? 0 : Float(clip.gain * logicalTrack.gain)
                appendAudio((start: start, end: end, gain: combinedGain,
                             fadeIn: clip.fadeIn, fadeOut: clip.fadeOut, automation: clip.automation), to: lane)
            }
        }

        // MARK: Audio mix (one params object per composition track)
        var mixParams: [AVMutableAudioMixInputParameters] = []
        for lane in audioLanes {
            let params = AVMutableAudioMixInputParameters(track: lane.track)
            params.setVolume(0, at: .zero)
            for clip in lane.clips.sorted(by: { $0.start < $1.start }) {
                let gain = min(clip.gain, 1) // AVAudioMix clamps at 1.0 (same limit as the legacy path).
                if clip.fadeIn > 0 {
                    params.setVolume(0, at: clip.start)
                    params.setVolumeRamp(fromStartVolume: 0, toEndVolume: gain,
                                         timeRange: CMTimeRange(start: clip.start, end: CMTimeAdd(clip.start, CMTime(seconds: clip.fadeIn, preferredTimescale: timescale))))
                } else {
                    params.setVolume(gain, at: clip.start)
                }
                // Automation (ducking): multipliers on the clip gain, ramped point to point.
                let points = clip.automation.sorted { $0.time.seconds < $1.time.seconds }
                for (i, point) in points.enumerated() {
                    let at = CMTimeAdd(clip.start, point.time.cmTime)
                    let value = min(1, gain * Float(point.gain))
                    if i + 1 < points.count {
                        let next = points[i + 1]
                        params.setVolumeRamp(fromStartVolume: value, toEndVolume: min(1, gain * Float(next.gain)),
                                             timeRange: CMTimeRange(start: at, end: CMTimeAdd(clip.start, next.time.cmTime)))
                    } else {
                        params.setVolume(value, at: at)
                    }
                }
                if clip.fadeOut > 0 {
                    let fadeStart = CMTimeSubtract(clip.end, CMTime(seconds: clip.fadeOut, preferredTimescale: timescale))
                    params.setVolumeRamp(fromStartVolume: gain, toEndVolume: 0,
                                         timeRange: CMTimeRange(start: max(fadeStart, clip.start), end: clip.end))
                }
                params.setVolume(0, at: clip.end)
            }
            mixParams.append(params)
        }
        let audioMix: AVAudioMix?
        if mixParams.isEmpty {
            audioMix = nil
        } else {
            let mix = AVMutableAudioMix()
            mix.inputParameters = mixParams
            audioMix = mix
        }

        // MARK: Video composition instructions
        let renderSize = FrameRenderer.evenSize(project.canvas.cgSize)
        let instructions = makeInstructions(project: project, layout: layout, visuals: visuals, renderSize: renderSize)
        let videoComposition = AVMutableVideoComposition()
        videoComposition.customVideoCompositorClass = ProjectVideoCompositor.self
        videoComposition.renderSize = renderSize
        let fps = project.assets.map(\.nominalFrameRate).filter { $0 > 0 }.max() ?? 30
        videoComposition.frameDuration = CMTime(value: 1, timescale: CMTimeScale(min(60, max(15, fps.rounded()))))
        videoComposition.instructions = instructions

        return ComposedVideo(
            asset: composition,
            videoComposition: videoComposition,
            audioMix: audioMix,
            renderSize: renderSize,
            duration: CMTimeGetSeconds(projectEnd))
    }

    // MARK: Instructions

    private static func makeInstructions(
        project: EditorProject,
        layout: [EditorProject.ClipLayout],
        visuals: ProjectVisuals,
        renderSize: CGSize
    ) -> [ProjectCompositionInstruction] {
        let captions = project.projectCaptions()
        var boundaries = Set<CMTime>()
        boundaries.insert(.zero)
        boundaries.insert(project.duration)
        for entry in layout {
            boundaries.insert(entry.start)
            boundaries.insert(entry.end)
            if entry.overlapWithPrevious > .zero {
                // Fade-through-black switches at the overlap midpoint.
                boundaries.insert(CMTimeAdd(entry.start, CMTimeMultiplyByFloat64(entry.overlapWithPrevious, multiplier: 0.5)))
            }
        }
        let sorted = boundaries.filter { $0 >= .zero && $0 <= project.duration }.sorted()
        var instructions: [ProjectCompositionInstruction] = []
        for (i, start) in sorted.enumerated() where i + 1 < sorted.count {
            let end = sorted[i + 1]
            guard end > start else { continue }
            let mid = CMTimeAdd(start, CMTimeMultiplyByFloat64(CMTimeSubtract(end, start), multiplier: 0.5))
            let active = layout.enumerated().filter { _, entry in mid >= entry.start && mid < entry.end }
            var layers: [ProjectCompositionInstruction.Layer] = []
            for (index, entry) in active {
                guard let clip = project.clip(entry.clipID), let visual = visuals[clip.id] else { continue }
                var opacityStart: Float = 1
                var opacityEnd: Float = 1
                if active.count > 1, let first = active.first, let last = active.last, first.offset != last.offset {
                    // Transition overlap: [later.start, earlier.end]; progress runs 0...1 across it.
                    let earlier = first.element
                    let later = last.element
                    let overlap = later.overlapWithPrevious
                    guard overlap > .zero else { if index != last.offset { continue }; else { layers.append(layer(visual, 1, 1)); continue } }
                    let pStart = Float(min(1, max(0, CMTimeGetSeconds(CMTimeSubtract(start, later.start)) / CMTimeGetSeconds(overlap))))
                    let pEnd = Float(min(1, max(0, CMTimeGetSeconds(CMTimeSubtract(end, later.start)) / CMTimeGetSeconds(overlap))))
                    let kind = project.videoClips[first.offset].transitionOut.kind
                    let isEarlier = index == first.offset
                    switch kind {
                    case .crossDissolve:
                        if isEarlier { opacityStart = 1 - pStart; opacityEnd = 1 - pEnd }
                        else { opacityStart = pStart; opacityEnd = pEnd }
                    case .fadeThroughBlack:
                        if isEarlier {
                            if pStart >= 0.5 { continue }
                            opacityStart = 1 - pStart * 2; opacityEnd = 1 - pEnd * 2
                        } else {
                            if pEnd <= 0.5 { continue }
                            opacityStart = (pStart - 0.5) * 2; opacityEnd = (pEnd - 0.5) * 2
                        }
                    case .cut:
                        if isEarlier { continue }
                    }
                    _ = earlier
                }
                layers.append(layer(visual, opacityStart, opacityEnd))
            }
            guard !layers.isEmpty else { continue }
            instructions.append(ProjectCompositionInstruction(
                timeRange: CMTimeRange(start: start, end: end),
                layers: layers, canvasSize: renderSize, fit: project.canvas.fit, captions: captions))
        }
        return instructions
    }

    private static func layer(_ visual: ProjectSegmentVisual, _ opacityStart: Float, _ opacityEnd: Float) -> ProjectCompositionInstruction.Layer {
        .init(trackID: visual.trackID, renderer: visual.renderer,
              naturalSize: visual.naturalSize, transform: visual.transform,
              orientedSize: visual.orientedSize,
              opacityStart: max(0, min(1, opacityStart)), opacityEnd: max(0, min(1, opacityEnd)))
    }
}

/// Per-segment visual data the compositor needs (kept out of the model layer).
struct ProjectSegmentVisual {
    var trackID: CMPersistentTrackID
    var renderer: FrameRenderer
    var naturalSize: CGSize
    var transform: CGAffineTransform
    var orientedSize: CGSize
}

private typealias ProjectVisuals = [UUID: ProjectSegmentVisual]
