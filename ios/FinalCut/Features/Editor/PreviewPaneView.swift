import SwiftUI
import AVKit
import UIKit

/// Preview uses AVKit/AVFoundation only (VideoPlayer + scrub when URL present).
struct PreviewPaneView: View {
    var state: EditorState
    var videoURL: URL?
    /// Dimmer copy while `processing` (Design: “Generating captions…” / “Translating…” / burn-in).
    var processingMessage: String = ProcessingOverlayKind.editing.message

    @State private var player = AVPlayer()

    var body: some View {
        ZStack {
            AppTheme.surface
            if let videoURL, MediaMIME.isImage(url: videoURL) {
                // Photo results (Backend #82 returns image/jpeg or image/png): no player.
                if let image = UIImage(contentsOfFile: videoURL.path) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .accessibilityIdentifier("PhotoPreview")
                } else {
                    emptyState
                }
            } else if videoURL != nil {
                VideoPlayer(player: player)
            } else {
                emptyState
            }

            if state == .uploading || state == .processing {
                VStack(spacing: 10) {
                    ProgressView()
                        .tint(AppTheme.accent)
                        .scaleEffect(1.2)
                    if state == .processing {
                        Text(processingMessage)
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(AppTheme.textPrimary)
                            .multilineTextAlignment(.center)
                    }
                }
                .padding(16)
                .background(AppTheme.surfaceElevated.opacity(0.9))
                .clipShape(RoundedRectangle(cornerRadius: AppTheme.cornerRadius))
            }
        }
        .accessibilityIdentifier("Preview")
        .onAppear { attachPlayer(url: videoURL) }
        .onChange(of: videoURL) { _, newURL in
            attachPlayer(url: newURL)
        }
        .onDisappear { player.pause() }
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
        case .empty:
            return "Import a video to preview"
        case .uploading:
            return "Uploading…"
        case .failed:
            return "Preview unavailable"
        case .ready, .processing:
            return "No local URL"
        }
    }

    private func attachPlayer(url: URL?) {
        if let url, MediaMIME.isImage(url: url) {
            player.pause()
            player.replaceCurrentItem(with: nil)
            return
        }
        let currentURL = (player.currentItem?.asset as? AVURLAsset)?.url
        guard currentURL != url else { return }
        player.pause()
        player.replaceCurrentItem(with: url.map { AVPlayerItem(url: $0) })
    }
}

#Preview {
    PreviewPaneView(state: .empty, videoURL: nil)
        .frame(height: 220)
}
