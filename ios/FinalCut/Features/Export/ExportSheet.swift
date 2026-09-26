import SwiftUI

/// Export: everything renders on the iPhone. Video shows a real percentage with Cancel and
/// saves to Photos; photos save in their original (or requested) format with a short spinner.
struct ExportSheet: View {
    @Environment(\.dismiss) private var dismiss
    var videoURL: URL?
    var state: EditorState
    var stack: EditStack? = nil

    @StateObject private var controller = ExportController()

    private var isPhoto: Bool {
        stack?.isPhoto ?? videoURL.map { MediaMIME.isImage(url: $0) } ?? false
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Image(systemName: isPhoto ? "photo" : "square.and.arrow.up")
                    .font(.system(size: 40))
                    .foregroundStyle(AppTheme.accent)

                Text(isPhoto ? UXCopy.exportPhotoTitle : "Export")
                    .font(.title2.bold())
                    .foregroundStyle(AppTheme.textPrimary)

                Text(statusCopy)
                    .font(.footnote)
                    .foregroundStyle(AppTheme.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
                    .accessibilityIdentifier(isPhoto ? "SavePhotoStatus" : "ExportStatus")

                progressSection

                actionButton

                if controller.showNotifyOffer, controller.isRunning {
                    Button(UXCopy.exportNotifyMe) { controller.requestNotifications() }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppTheme.accent)
                        .accessibilityIdentifier("ExportNotifyMe")
                }

                Spacer()
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(AppTheme.background.ignoresSafeArea())
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        controller.cancel()
                        dismiss()
                    }
                }
            }
            .navigationTitle(isPhoto ? UXCopy.exportPhotoTitle : "Export")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(controller.isRunning)
        .accessibilityIdentifier("ExportSheet")
    }

    @ViewBuilder
    private var progressSection: some View {
        switch controller.phase {
        case .rendering(let percent):
            VStack(spacing: 8) {
                ProgressView(value: Double(percent), total: 100)
                    .tint(AppTheme.accent)
                Text(UXCopy.exportRendering(percent: percent))
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(AppTheme.textPrimary)
                Text(UXCopy.exportLeaveHint)
                    .font(.caption)
                    .foregroundStyle(AppTheme.textSecondary)
                    .multilineTextAlignment(.center)
            }
            .accessibilityIdentifier("ExportProgress")
        case .saving:
            ProgressView().tint(AppTheme.accent)
        default:
            EmptyView()
        }
    }

    @ViewBuilder
    private var actionButton: some View {
        if controller.isRunning {
            if case .rendering = controller.phase {
                Button("Cancel", role: .cancel) { controller.cancel() }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("ExportCancel")
            }
        } else if controller.phase == .done {
            Button("Done") { dismiss() }
                .buttonStyle(.borderedProminent)
                .tint(AppTheme.accent)
        } else {
            Button(isPhoto ? UXCopy.exportPhotoTitle : "Save video") {
                controller.start(stack: stack, fallbackURL: videoURL)
            }
            .buttonStyle(.borderedProminent)
            .tint(AppTheme.accent)
            .disabled(!canExport)
            .accessibilityIdentifier(isPhoto ? "SavePhoto" : "SaveVideo")
        }
    }

    private var canExport: Bool {
        (stack != nil || videoURL != nil) && state != .processing && state != .uploading
    }

    private var statusCopy: String {
        switch controller.phase {
        case .done:
            return isPhoto ? UXCopy.savedToPhotos : "\(UXCopy.savedToPhotos). \(UXCopy.exportRenderedLocal)"
        case .failed(let message):
            return message
        case .cancelled, .idle, .rendering, .saving:
            break
        }
        switch state {
        case .empty:
            return isPhoto ? "Import a photo before saving." : "Import a video before exporting."
        case .uploading:
            return "Still uploading…"
        case .processing:
            return "Finishing your edit — export when it's done."
        case .ready, .failed:
            return isPhoto
                ? "Saves the edited photo to Photos in its original format."
                : "Renders your edits on your iPhone and saves the video to Photos."
        }
    }
}

#Preview {
    ExportSheet(videoURL: nil, state: .empty)
}
