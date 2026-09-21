import SwiftUI

struct ExportSheet: View {
    @Environment(\.dismiss) private var dismiss
    var videoURL: URL?
    var state: EditorState

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 40))
                    .foregroundStyle(AppTheme.accent)

                Text("Export")
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

                Button("Share / Save (stub)") {
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .tint(AppTheme.accent)
                .disabled(videoURL == nil || state == .processing || state == .uploading)

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
            .navigationTitle("ExportSheet")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
        .accessibilityIdentifier("ExportSheet")
    }

    private var statusCopy: String {
        switch state {
        case .empty:
            return "Import and process a video before exporting."
        case .uploading:
            return "Still uploading…"
        case .processing:
            return "Server still processing — export when ready."
        case .ready:
            return "Ready to export the current preview asset."
        case .failed:
            return "Fix the failed job before exporting."
        }
    }
}

#Preview {
    ExportSheet(videoURL: nil, state: .empty)
}
