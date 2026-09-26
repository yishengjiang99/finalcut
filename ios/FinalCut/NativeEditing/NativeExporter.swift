import AVFoundation
import Foundation

/// Renders a composed edit to a file (the only time pixels are written).
final class NativeExporter: @unchecked Sendable {
    enum ExportError: Error, Equatable {
        case cannotCreateSession
        case failed
        case cancelled
    }

    private var session: AVAssetExportSession?

    /// Exports `composed` as mp4 (default) or mov. `progress` is called on the main actor.
    func export(
        _ composed: ComposedVideo,
        format: String?,
        progress: @escaping @MainActor (Double) -> Void
    ) async throws -> URL {
        guard let session = AVAssetExportSession(asset: composed.asset, presetName: AVAssetExportPresetHighestQuality) else {
            throw ExportError.cannotCreateSession
        }
        let fileType: AVFileType = format == "mov" ? .mov : .mp4
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("FinalCap-\(UUID().uuidString.prefix(8)).\(fileType == .mov ? "mov" : "mp4")")
        session.outputURL = url
        session.outputFileType = fileType
        session.videoComposition = composed.videoComposition
        session.audioMix = composed.audioMix
        session.audioTimePitchAlgorithm = .spectral
        session.shouldOptimizeForNetworkUse = true
        self.session = session

        let ticker = Task {
            while !Task.isCancelled {
                let value = Double(session.progress)
                await progress(value)
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        }
        defer { ticker.cancel() }

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            session.exportAsynchronously { continuation.resume() }
        }
        switch session.status {
        case .completed:
            await progress(1)
            return url
        case .cancelled:
            throw ExportError.cancelled
        default:
            throw ExportError.failed
        }
    }

    func cancel() {
        session?.cancelExport()
    }
}
