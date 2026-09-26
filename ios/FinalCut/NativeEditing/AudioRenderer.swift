import AVFoundation
import Foundation

/// Offline audio processing for effects the audio mix can't do (gain above 1.0).
/// Reads the timeline's audio as PCM, processes it in Swift and writes a CAF that
/// replaces the composition's audio track. Results are cached per input.
enum AudioRenderer {
    enum RenderError: Error {
        case readerFailed
    }

    static let sampleRate: Double = 44_100
    private static let cache = RenderCache()

    static func renderGain(composition: AVComposition, track: AVCompositionTrack, gain: Float) async throws -> URL {
        let key = cacheKey(composition: composition, gain: gain)
        if let cached = await cache.url(for: key), FileManager.default.fileExists(atPath: cached.path) {
            return cached
        }
        let channels = try await channelCount(of: track)
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("native-audio-\(UUID().uuidString).caf")
        try await Task.detached(priority: .userInitiated) {
            try render(composition: composition, track: track, channels: channels, to: url) { samples in
                for i in samples.indices {
                    samples[i] = max(-1, min(1, samples[i] * gain))
                }
            }
        }.value
        await cache.store(url, for: key)
        return url
    }

    /// Clip-level key: source segments + gain.
    private static func cacheKey(composition: AVComposition, gain: Float) -> String {
        var parts: [String] = ["g\(gain)"]
        for track in composition.tracks where track.mediaType == .audio {
            for segment in track.segments {
                let m = segment.timeMapping
                parts.append("\(segment.sourceURL?.path ?? "-")@\(m.source.start.seconds)+\(m.source.duration.seconds)>\(m.target.start.seconds)+\(m.target.duration.seconds)")
            }
        }
        return parts.joined(separator: "|")
    }

    static func channelCount(of track: AVAssetTrack) async throws -> Int {
        let descriptions = try await track.load(.formatDescriptions)
        for description in descriptions {
            if let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee {
                return max(1, min(2, Int(asbd.mChannelsPerFrame)))
            }
        }
        return 2
    }

    /// Reads interleaved float PCM from `track` (as placed in `composition`), lets
    /// `process` modify each chunk in place, and writes a float CAF.
    static func render(
        composition: AVComposition,
        track: AVCompositionTrack,
        channels: Int,
        to url: URL,
        process: (inout [Float]) -> Void
    ) throws {
        let reader = try AVAssetReader(asset: composition)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: channels,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsNonInterleaved: false,
            AVLinearPCMIsBigEndianKey: false,
        ]
        let output = AVAssetReaderAudioMixOutput(audioTracks: [track], audioSettings: settings)
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { throw RenderError.readerFailed }
        reader.add(output)
        guard reader.startReading() else { throw reader.error ?? RenderError.readerFailed }

        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate,
                                         channels: AVAudioChannelCount(channels), interleaved: false) else {
            throw RenderError.readerFailed
        }
        let file = try AVAudioFile(forWriting: url, settings: format.settings, commonFormat: .pcmFormatFloat32, interleaved: false)

        while let sample = output.copyNextSampleBuffer() {
            guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
            let byteCount = CMBlockBufferGetDataLength(block)
            var samples = [Float](repeating: 0, count: byteCount / MemoryLayout<Float>.size)
            let status = samples.withUnsafeMutableBytes { raw in
                CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: byteCount, destination: raw.baseAddress!)
            }
            guard status == kCMBlockBufferNoErr else { continue }
            process(&samples)
            let frames = samples.count / channels
            guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else { continue }
            buffer.frameLength = AVAudioFrameCount(frames)
            if let data = buffer.floatChannelData {
                for c in 0..<channels {
                    let dst = data[c]
                    for f in 0..<frames { dst[f] = samples[f * channels + c] }
                }
            }
            try file.write(from: buffer)
        }
        if reader.status == .failed { throw reader.error ?? RenderError.readerFailed }
    }

    /// RMS of a composed asset's audio (tests and levels UI).
    static func rms(asset: AVAsset, audioMix: AVAudioMix?, from start: Double = 0, to end: Double? = nil) async throws -> Double {
        guard let track = try await asset.loadTracks(withMediaType: .audio).first else { return 0 }
        let reader = try AVAssetReader(asset: asset)
        if let end {
            reader.timeRange = CMTimeRange(start: CMTime(seconds: start, preferredTimescale: 600),
                                           end: CMTime(seconds: end, preferredTimescale: 600))
        } else if start > 0 {
            reader.timeRange = CMTimeRange(start: CMTime(seconds: start, preferredTimescale: 600), duration: .positiveInfinity)
        }
        let output = AVAssetReaderAudioMixOutput(audioTracks: [track], audioSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsNonInterleaved: false,
            AVLinearPCMIsBigEndianKey: false,
        ])
        output.audioMix = audioMix
        reader.add(output)
        guard reader.startReading() else { throw reader.error ?? RenderError.readerFailed }
        var sum = 0.0
        var count = 0
        while let sample = output.copyNextSampleBuffer() {
            guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
            let length = CMBlockBufferGetDataLength(block)
            var floats = [Float](repeating: 0, count: length / 4)
            _ = floats.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: $0.baseAddress!) }
            for v in floats { sum += Double(v * v) }
            count += floats.count
        }
        return count > 0 ? (sum / Double(count)).squareRoot() : 0
    }
}

private actor RenderCache {
    private var entries: [String: URL] = [:]
    func url(for key: String) -> URL? { entries[key] }
    func store(_ url: URL, for key: String) { entries[key] = url }
}
