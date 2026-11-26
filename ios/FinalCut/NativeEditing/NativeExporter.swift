import AVFoundation
import Foundation

/// Renders a composed edit to a file (the only time pixels are written).
final class NativeExporter: @unchecked Sendable {
    enum ExportError: Error, Equatable {
        case cannotCreateSession
        case failed
        case failedWithReason(String)
        case cancelled
    }

    private var session: AVAssetExportSession?

    /// Exports `composed` as mp4 (default) or mov. `progress` is called on the main actor.
    func export(
        _ composed: ComposedVideo,
        format: String?,
        progress: @escaping @MainActor (Double) -> Void
    ) async throws -> URL {
        let preset = await Self.presetName(for: composed.asset)
        guard let session = AVAssetExportSession(asset: composed.asset, presetName: preset)
            ?? AVAssetExportSession(asset: composed.asset, presetName: AVAssetExportPresetHighestQuality) else {
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
        return try await run(session, to: url, progress: progress)
    }

    /// HEVC when any source video is HEVC, else H.264. iPhone HDR (10-bit HLG / Dolby
    /// Vision) is always HEVC, and the H.264 preset converts it to 8-bit SDR; the HEVC
    /// preset keeps it, at higher quality per bit. H.264 sources stay H.264, so an edit
    /// plays wherever the original did. Composition tracks report their sources' codecs.
    static func presetName(for asset: AVAsset) async -> String {
        let hevc: Set<FourCharCode> = [kCMVideoCodecType_HEVC, kCMVideoCodecType_HEVCWithAlpha, kCMVideoCodecType_DolbyVisionHEVC]
        for track in (try? await asset.loadTracks(withMediaType: .video)) ?? [] {
            let formats = (try? await track.load(.formatDescriptions)) ?? []
            if formats.contains(where: { hevc.contains(CMFormatDescriptionGetMediaSubType($0)) }) {
                return AVAssetExportPresetHEVCHighestQuality
            }
        }
        return AVAssetExportPresetHighestQuality
    }

    /// Lossless export of a trim-only stack: copies the source media inside
    /// `range` without re-encoding, so quality and HDR survive untouched.
    /// Passthrough must keep the source's own container — mirror its extension.
    func exportPassthrough(
        base: URL,
        range: (start: Double, end: Double),
        progress: @escaping @MainActor (Double) -> Void
    ) async throws -> URL {
        let asset = AVURLAsset(url: base)
        guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetPassthrough) else {
            throw ExportError.cannotCreateSession
        }
        let fileType: AVFileType
        let ext: String
        switch base.pathExtension.lowercased() {
        case "mov": fileType = .mov; ext = "mov"
        case "m4v": fileType = .m4v; ext = "m4v"
        default: fileType = .mp4; ext = "mp4"
        }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("FinalCap-\(UUID().uuidString.prefix(8)).\(ext)")
        session.outputURL = url
        session.outputFileType = fileType
        session.timeRange = CMTimeRange(
            start: CMTime(seconds: range.start, preferredTimescale: 600),
            end: CMTime(seconds: range.end, preferredTimescale: 600))
        return try await run(session, to: url, progress: progress)
    }

    /// Runs a configured session to completion, ticking `progress` as it goes.
    private func run(
        _ session: AVAssetExportSession,
        to url: URL,
        progress: @escaping @MainActor (Double) -> Void
    ) async throws -> URL {
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
            // Keep the AVFoundation reason: a bare "failed" made export bugs
            // undiagnosable from the sheet's generic failure copy.
            if let error = session.error as NSError? {
                throw ExportError.failedWithReason("\(error.domain) \(error.code): \(error.localizedDescription)")
            }
            throw ExportError.failed
        }
    }

    func cancel() {
        session?.cancelExport()
    }
}
