import AVFoundation
import Foundation

/// Server limits for `/api/lyric-captions` audio (docs/api/LYRIC_CAPTIONS.md).
enum LyricCaptionsLimits {
    /// 10 minutes.
    static let maxSeconds = 600.0
    /// 25 MB.
    static let maxBytes = 25_000_000
}

/// Extracts the edited clip's audio track (never the picture) as an m4a file to upload.
enum LyricAudioExporter {
    enum ExportError: Error { case cannotCreateSession, failed }

    static func exportM4A(_ composed: ComposedVideo) async throws -> URL {
        guard let session = AVAssetExportSession(asset: composed.asset, presetName: AVAssetExportPresetAppleM4A) else {
            throw ExportError.cannotCreateSession
        }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("FinalCap-audio-\(UUID().uuidString.prefix(8)).m4a")
        session.outputURL = url
        session.outputFileType = .m4a
        session.audioMix = composed.audioMix
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            session.exportAsynchronously { continuation.resume() }
        }
        guard session.status == .completed else {
            try? FileManager.default.removeItem(at: url)
            throw ExportError.failed
        }
        return url
    }
}
