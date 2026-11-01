import SwiftUI
import AVKit
import UIKit

/// Preview of the edited clip or photo. Videos play the composed `AVPlayerItem` (edits are
/// live, nothing is rendered until export). Photos show the Core Image render, aspect-fit,
/// with no timeline or playback controls.
struct PreviewPaneView: View {
    var state: EditorState
    var videoURL: URL?
    /// Dimmer copy (cloud steps only; device edits never dim the preview).
    var processingMessage: String = ProcessingOverlayKind.editing.message
    /// Import progress (e.g. building a slideshow); replaces the generic importing copy.
    var statusMessage: String? = nil
    /// Composed preview for the current edit stack.
    var playerItem: AVPlayerItem? = nil
    /// Rendered photo for the current edit stack.
    var photo: UIImage? = nil
    /// Only cloud steps (and uploads) dim the preview.
    var showsDimmer: Bool = false
    var canUndo: Bool = false
    var onUndo: () -> Void = {}
    /// Stops a cloud step in flight (translated captions); nil hides the button.
    var onCancel: (() -> Void)? = nil
    /// Seek requested by the timeline scrubber / seek_playhead tool.
    var seek: PlayheadSeek? = nil
    /// Reports the player's time (~15 Hz) so the timeline playhead follows playback.
    var onTimeChange: (Double) -> Void = { _ in }

    @State private var player = AVPlayer()
    @State private var timeObserver: Any?

    private var isPhoto: Bool {
        videoURL.map { MediaMIME.isImage(url: $0) } ?? false
    }

    var body: some View {
        ZStack {
            AppTheme.surface
            if isPhoto {
                if let image = photo ?? videoURL.flatMap({ UIImage(contentsOfFile: $0.path) }) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .accessibilityIdentifier("PhotoPreview")
                } else {
                    ProgressView().tint(AppTheme.accent)
                }
            } else if videoURL != nil {
                VideoPlayer(player: player)
            } else {
                emptyState
            }

            if showsDimmer || state.transferMessage != nil {
                Color.black.opacity(0.35)
                VStack(spacing: 10) {
                    ProgressView()
                        .tint(AppTheme.accent)
                        .scaleEffect(1.2)
                    Text(state.transferMessage.map { statusMessage ?? $0 } ?? processingMessage)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(AppTheme.textPrimary)
                        .multilineTextAlignment(.center)
                    if let onCancel {
                        Button("Cancel", action: onCancel)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(AppTheme.accent)
                            .accessibilityIdentifier("CancelCaptions")
                    }
                }
                .padding(16)
                .background(AppTheme.surfaceElevated.opacity(0.9))
                .clipShape(RoundedRectangle(cornerRadius: AppTheme.cornerRadius))
            }
        }
        .overlay(alignment: .topTrailing) {
            if canUndo {
                Button(action: onUndo) {
                    Label(UXCopy.undo, systemImage: "arrow.uturn.backward")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AppTheme.textPrimary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(AppTheme.surfaceElevated.opacity(0.9))
                        .clipShape(Capsule())
                }
                .padding(8)
                .accessibilityIdentifier("UndoEdit")
            }
        }
        .accessibilityIdentifier("Preview")
        .onAppear {
            attach()
            if timeObserver == nil {
                let report = onTimeChange
                timeObserver = player.addPeriodicTimeObserver(
                    forInterval: CMTime(value: 1, timescale: 15), queue: .main) { time in
                    if time.isValid, time.seconds.isFinite { report(time.seconds) }
                }
            }
        }
        .onChange(of: videoURL) { _, _ in attach() }
        .onChange(of: playerItem) { _, _ in attach() }
        .onChange(of: seek) { _, seek in
            guard let seek, seek.seconds.isFinite else { return }
            // A drag in flight takes any nearby frame (keeps up with the finger); the
            // final seek lands exactly.
            let tolerance = seek.exact ? CMTime.zero : CMTime(value: 1, timescale: 10)
            player.seek(to: CMTime(seconds: seek.seconds, preferredTimescale: 600),
                        toleranceBefore: tolerance, toleranceAfter: tolerance)
        }
        .onDisappear {
            player.pause()
            if let timeObserver { player.removeTimeObserver(timeObserver) }
            timeObserver = nil
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "video.slash")
                .font(.largeTitle)
                .foregroundStyle(AppTheme.textSecondary)
            Text(emptyCopy)
                .font(.subheadline)
                .foregroundStyle(AppTheme.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
        }
    }

    private var emptyCopy: String {
        switch state {
        case .empty: return "Import a photo or video to preview"
        case .importing, .uploading: return state.transferMessage ?? ""
        case .failed: return "Preview unavailable"
        case .ready, .processing: return "No local URL"
        }
    }

    /// Swaps in the composed item, keeping the playhead where it was.
    private func attach() {
        if isPhoto || videoURL == nil {
            player.pause()
            player.replaceCurrentItem(with: nil)
            return
        }
        if let playerItem {
            guard player.currentItem !== playerItem else { return }
            let time = player.currentTime()
            let wasPlaying = player.rate > 0
            player.replaceCurrentItem(with: playerItem)
            if time.isValid, time.seconds > 0 {
                player.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero)
            }
            if wasPlaying { player.play() }
            return
        }
        let currentURL = (player.currentItem?.asset as? AVURLAsset)?.url
        guard currentURL != videoURL else { return }
        player.pause()
        player.replaceCurrentItem(with: videoURL.map { AVPlayerItem(url: $0) })
    }
}

#Preview {
    PreviewPaneView(state: .empty, videoURL: nil)
        .frame(height: 220)
}
