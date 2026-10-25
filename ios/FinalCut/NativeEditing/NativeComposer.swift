import AVFoundation
import CoreImage
import Foundation

/// A composed, not-yet-rendered edit: feed it to `AVPlayerItem`, `AVAssetImageGenerator`
/// or `AVAssetExportSession`.
struct ComposedVideo: @unchecked Sendable {
    let asset: AVAsset
    let videoComposition: AVVideoComposition?
    let audioMix: AVAudioMix?
    let renderSize: CGSize
    let duration: Double

    func makePlayerItem() -> AVPlayerItem {
        let item = AVPlayerItem(asset: asset)
        item.videoComposition = videoComposition
        item.audioMix = audioMix
        item.audioTimePitchAlgorithm = .spectral
        return item
    }

    func makeImageGenerator(maxSize: CGSize? = nil) -> AVAssetImageGenerator {
        let generator = AVAssetImageGenerator(asset: asset)
        generator.videoComposition = videoComposition
        generator.appliesPreferredTrackTransform = true
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        if let maxSize { generator.maximumSize = maxSize }
        return generator
    }
}

enum NativeComposerError: Error {
    case noVideoTrack
}

/// Builds `ComposedVideo` from an edit stack.
enum NativeComposer {
    static let timescale: CMTimeScale = 600

    static func compose(_ stack: EditStack) async throws -> ComposedVideo {
        let source = AVURLAsset(url: stack.base)
        let composition = AVMutableComposition()
        let sourceDuration = try await source.load(.duration)
        let fullRange = CMTimeRange(start: .zero, duration: sourceDuration)

        guard let sourceVideo = try await source.loadTracks(withMediaType: .video).first else {
            throw NativeComposerError.noVideoTrack
        }
        let (naturalSize, transform, fps, videoRange) = try await sourceVideo.load(.naturalSize, .preferredTransform, .nominalFrameRate, .timeRange)
        let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)
        try videoTrack?.insertTimeRange(videoRange.intersection(fullRange), of: sourceVideo, at: .zero)
        videoTrack?.preferredTransform = transform

        var audioTrack: AVMutableCompositionTrack?
        if let sourceAudio = try await source.loadTracks(withMediaType: .audio).first {
            let audioRange = try await sourceAudio.load(.timeRange)
            audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
            try audioTrack?.insertTimeRange(audioRange.intersection(fullRange), of: sourceAudio, at: .zero)
        }

        // Timeline ops, in stack order, on the current timeline.
        for op in stack.ops {
            switch op {
            case .trim(let start, let end):
                let s = CMTime(seconds: start, preferredTimescale: timescale)
                let e = CMTime(seconds: end, preferredTimescale: timescale)
                if e < composition.duration {
                    composition.removeTimeRange(CMTimeRange(start: e, end: composition.duration))
                }
                if s > .zero {
                    composition.removeTimeRange(CMTimeRange(start: .zero, end: s))
                }
            case .speed(let factor):
                let current = composition.duration
                composition.scaleTimeRange(
                    CMTimeRange(start: .zero, duration: current),
                    toDuration: CMTimeMultiplyByFloat64(current, multiplier: 1 / factor)
                )
            default:
                break
            }
        }

        // Audio: gain > 1 needs an offline render (the audio mix clamps at 1.0).
        let gain = stack.ops.reduce(1.0) { acc, op in
            if case .volume(let v) = op { return acc * v }
            return acc
        }
        if gain > 1.0001, let track = audioTrack {
            let rendered = try await AudioRenderer.renderGain(composition: composition, track: track, gain: Float(gain))
            let renderedAsset = AVURLAsset(url: rendered)
            if let renderedTrack = try await renderedAsset.loadTracks(withMediaType: .audio).first {
                let renderedRange = try await renderedTrack.load(.timeRange)
                composition.removeTrack(track)
                let replacement = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
                try replacement?.insertTimeRange(
                    renderedRange.intersection(CMTimeRange(start: .zero, duration: composition.duration)),
                    of: renderedTrack, at: .zero
                )
                audioTrack = replacement
            }
        }
        // YouTube soundtrack: a second audio track holding the fetched song, inserted
        // after the offline gain render so it is never baked into it. The song starts
        // at the op's startOffset and is trimmed to the final timeline's length (or
        // left short — the remainder is silence, like the web's pad-to-video-end).
        let soundtrack = stack.soundtrack
        var soundtrackTrack: AVMutableCompositionTrack?
        if let soundtrack {
            let song = AVURLAsset(url: soundtrack.file)
            if let songAudio = try await song.loadTracks(withMediaType: .audio).first {
                let songDuration = try await song.load(.duration)
                let start = CMTime(seconds: soundtrack.startOffset, preferredTimescale: timescale)
                let length = min(composition.duration, CMTimeSubtract(songDuration, start))
                if length > .zero {
                    let track = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
                    try track?.insertTimeRange(CMTimeRange(start: start, duration: length), of: songAudio, at: .zero)
                    soundtrackTrack = track
                }
            }
        }

        let mixVolume = Float(min(gain, 1))
        let audioMix = makeAudioMix(
            track: audioTrack, volume: mixVolume,
            soundtrackTrack: soundtrackTrack,
            soundtrackOriginalVolume: soundtrack.map { Float($0.originalVolume) } ?? 0,
            ops: stack.ops, duration: composition.duration
        )

        // Frame ops: one Core Image chain per frame.
        let orientedRect = CGRect(origin: .zero, size: naturalSize).applying(transform)
        let orientedSize = CGSize(width: abs(orientedRect.width), height: abs(orientedRect.height))
        let renderer = FrameRenderer(ops: stack.ops, sourceSize: orientedSize, captions: stack.captionCues, lyric: stack.lyricTrack)
        let renderSize = FrameRenderer.evenSize(renderer.outputSize)
        let videoComposition = try await AVMutableVideoComposition.videoComposition(with: composition) { request in
            var image = request.sourceImage
            // Normalise if the frame arrives in natural (unrotated) orientation.
            if transform != .identity,
               abs(image.extent.width - naturalSize.width) < 1, abs(image.extent.height - naturalSize.height) < 1,
               abs(naturalSize.width - orientedSize.width) > 1 {
                image = image.transformed(by: transform)
            }
            request.finish(with: renderer.apply(to: image, time: CMTimeGetSeconds(request.compositionTime)), context: nil)
        }
        videoComposition.renderSize = renderSize
        let rate = fps > 0 ? fps : 30
        videoComposition.frameDuration = CMTime(value: 1, timescale: CMTimeScale(rate.rounded()))

        return ComposedVideo(
            asset: composition,
            videoComposition: videoComposition,
            audioMix: audioMix,
            renderSize: renderSize,
            duration: CMTimeGetSeconds(composition.duration)
        )
    }

    /// Volume (≤ 1) and fades anchored to the final timeline. With a soundtrack
    /// track, the original audio is additionally scaled to the soundtrack's
    /// `originalVolume` (0 = the song replaces it) and the song plays at full volume.
    static func makeAudioMix(track: AVCompositionTrack?, volume: Float, soundtrackTrack: AVCompositionTrack?, soundtrackOriginalVolume: Float, ops: [NativeOp], duration: CMTime) -> AVAudioMix? {
        let fades: [(isIn: Bool, duration: Double, start: Double?)] = ops.compactMap {
            if case .fade(let isIn, let d, let s) = $0 { return (isIn, d, s) }
            return nil
        }
        let originalVolume = soundtrackTrack != nil ? volume * soundtrackOriginalVolume : volume
        guard soundtrackTrack != nil || originalVolume < 0.9999 || !fades.isEmpty else { return nil }
        var allParams: [AVMutableAudioMixInputParameters] = []
        if let track {
            let params = AVMutableAudioMixInputParameters(track: track)
            let total = CMTimeGetSeconds(duration)
            let fadeIn = fades.last { $0.isIn }
            let fadeOut = fades.last { !$0.isIn }
            func t(_ s: Double) -> CMTime { CMTime(seconds: max(0, min(s, total)), preferredTimescale: timescale) }

            params.setVolume(fadeIn == nil ? originalVolume : 0, at: .zero)
            if let fadeIn {
                let start = fadeIn.start ?? 0
                params.setVolumeRamp(fromStartVolume: 0, toEndVolume: originalVolume,
                                     timeRange: CMTimeRange(start: t(start), end: t(start + fadeIn.duration)))
            }
            if let fadeOut {
                let start = fadeOut.start ?? max(0, total - fadeOut.duration)
                params.setVolumeRamp(fromStartVolume: originalVolume, toEndVolume: 0,
                                     timeRange: CMTimeRange(start: t(start), end: t(start + fadeOut.duration)))
                if start + fadeOut.duration < total {
                    params.setVolume(0, at: t(start + fadeOut.duration))
                }
            }
            allParams.append(params)
        }
        if let soundtrackTrack {
            let params = AVMutableAudioMixInputParameters(track: soundtrackTrack)
            params.setVolume(1, at: .zero)
            allParams.append(params)
        }
        guard !allParams.isEmpty else { return nil }
        let mix = AVMutableAudioMix()
        mix.inputParameters = allParams
        return mix
    }
}
