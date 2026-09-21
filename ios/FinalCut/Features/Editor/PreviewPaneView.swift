import SwiftUI
import AVKit

/// Preview uses AVKit/AVFoundation only (VideoPlayer + scrub when URL present).
struct PreviewPaneView: View {
    var state: EditorState
    var videoURL: URL?
    /// Dimmer copy while `processing` (Design: “Generating captions…” / “Translating…” / burn-in).
    var processingMessage: String = ProcessingOverlayKind.editing.message

    @State private var player: AVPlayer?

    var body: some View {
        ZStack {
            AppTheme.surface
            if let videoURL, state == .ready || state == .processing {
                VideoPlayer(player: player)
                    .onAppear { attachPlayer(url: videoURL) }
                    .onChange(of: videoURL) { _, newURL in
                        if let newURL { attachPlayer(url: newURL) }
                    }
                    .onDisappear {
                        player?.pause()
                        player = nil
                    }
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

    private func attachPlayer(url: URL) {
        player?.pause()
        player = AVPlayer(url: url)
    }
}

#Preview {
    PreviewPaneView(state: .empty, videoURL: nil)
        .frame(height: 220)
}
