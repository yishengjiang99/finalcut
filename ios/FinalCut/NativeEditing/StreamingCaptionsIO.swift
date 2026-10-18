import AVFoundation
import Foundation

/// The real WebSocket to ElevenLabs (`wss://…?token=sutkn_…`).
final class URLSessionCaptionSocket: CaptionSocket, @unchecked Sendable {
    private let task: URLSessionWebSocketTask

    init(url: URL, session: URLSession = .shared) {
        task = session.webSocketTask(with: url)
        task.resume()
    }

    func send(_ text: String) async throws {
        try await task.send(.string(text))
    }

    func receive() async throws -> String {
        switch try await task.receive() {
        case .string(let text): return text
        case .data(let data): return String(decoding: data, as: UTF8.self)
        @unknown default: return ""
        }
    }

    func close() {
        task.cancel(with: .normalClosure, reason: nil)
    }
}

/// Decodes the EDITED clip's audio (trim, speed, volume applied) to 16 kHz mono 16-bit PCM,
/// on the device. Only these samples are ever streamed; the picture never leaves.
enum CaptionAudioDecoder {
    enum DecodeError: Error { case noAudio, failed }

    static func pcm16kMono(_ composed: ComposedVideo) async throws -> [Int16] {
        let tracks = try await composed.asset.loadTracks(withMediaType: .audio)
        guard !tracks.isEmpty else { throw DecodeError.noAudio }
        let asset = composed.asset
        let mix = composed.audioMix
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(with: Result { try read(asset: asset, tracks: tracks, mix: mix) })
            }
        }
    }

    private static func read(asset: AVAsset, tracks: [AVAssetTrack], mix: AVAudioMix?) throws -> [Int16] {
        let reader = try AVAssetReader(asset: asset)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: StreamingConstants.sampleRate,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]
        let output = AVAssetReaderAudioMixOutput(audioTracks: tracks, audioSettings: settings)
        output.audioMix = mix
        guard reader.canAdd(output) else { throw DecodeError.failed }
        reader.add(output)
        guard reader.startReading() else { throw DecodeError.failed }
        // Stop a little past the limit: the engine refuses anything over 10 minutes.
        let cap = Int(StreamingConstants.maxAudioSeconds + 5) * StreamingConstants.sampleRate
        var samples: [Int16] = []
        while let buffer = output.copyNextSampleBuffer() {
            guard let block = CMSampleBufferGetDataBuffer(buffer) else { continue }
            let length = CMBlockBufferGetDataLength(block)
            let count = length / MemoryLayout<Int16>.size
            if count == 0 { continue }
            var chunk = [Int16](repeating: 0, count: count)
            let status = chunk.withUnsafeMutableBytes {
                CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: count * MemoryLayout<Int16>.size, destination: $0.baseAddress!)
            }
            guard status == kCMBlockBufferNoErr else { throw DecodeError.failed }
            samples.append(contentsOf: chunk)
            if samples.count > cap { break }
        }
        if reader.status == .failed { throw DecodeError.failed }
        return samples
    }
}
