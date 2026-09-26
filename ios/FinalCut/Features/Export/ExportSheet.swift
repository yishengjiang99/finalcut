import SwiftUI

struct ExportSheet: View {
    @Environment(\.dismiss) private var dismiss
    var videoURL: URL?
    var state: EditorState

    @State private var saving = false
    @State private var saveMessage: String?

    private var isPhoto: Bool {
        videoURL.map { MediaMIME.isImage(url: $0) } ?? false
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

                if let videoURL {
                    Text(videoURL.lastPathComponent)
                        .font(.caption.monospaced())
                        .foregroundStyle(AppTheme.textSecondary)
                }

                if isPhoto {
                    Button {
                        Task { await savePhoto() }
                    } label: {
                        if saving {
                            // No render percentage for photos: a short spinner (§7).
                            ProgressView().tint(.black)
                        } else {
                            Text(UXCopy.exportPhotoTitle)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(AppTheme.accent)
                    .disabled(!canExport || saving)
                    .accessibilityIdentifier("SavePhoto")

                    if let saveMessage {
                        Text(saveMessage)
                            .font(.footnote)
                            .foregroundStyle(AppTheme.textSecondary)
                            .accessibilityIdentifier("SavePhotoStatus")
                    }
                } else {
                    Button("Share / Save (stub)") {
                        dismiss()
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(AppTheme.accent)
                    .disabled(!canExport)
                }

                Spacer()
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(AppTheme.background.ignoresSafeArea())
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .navigationTitle(isPhoto ? UXCopy.exportPhotoTitle : "ExportSheet")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
        .accessibilityIdentifier("ExportSheet")
    }

    private var canExport: Bool {
        videoURL != nil && state != .processing && state != .uploading
    }

    private func savePhoto() async {
        guard let videoURL else { return }
        saving = true
        saveMessage = nil
        defer { saving = false }
        do {
            try await PhotoLibrarySaver.savePhoto(at: videoURL)
            saveMessage = UXCopy.savedToPhotos
        } catch {
            saveMessage = UXCopy.saveFailed
        }
    }

    private var statusCopy: String {
        switch state {
        case .empty:
            return isPhoto ? "Import a photo before saving." : "Import and process a video before exporting."
        case .uploading:
            return "Still uploading…"
        case .processing:
            return "Server still processing — export when ready."
        case .ready:
            return isPhoto ? "Saves the edited photo to Photos in its original format." : "Ready to export the current preview asset."
        case .failed:
            return "Fix the failed job before exporting."
        }
    }
}

#Preview {
    ExportSheet(videoURL: nil, state: .empty)
}
