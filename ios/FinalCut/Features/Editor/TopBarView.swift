import SwiftUI
import PhotosUI

/// Dark chrome top bar: title (leading) · Import (Photos) · Export (when a clip is ready) · Upgrade (trailing).
struct TopBarView: View {
    @Binding var photosPickerItem: PhotosPickerItem?
    var onExport: () -> Void
    var onUpgrade: () -> Void
    var importEnabled = true
    var exportVisible = false
    var exportEnabled = true
    var showUpgrade = true
    /// Remaining free requests today (shown subtly next to Upgrade when known).
    var freeRemaining: Int?

    var body: some View {
        HStack(spacing: 14) {
            Text("FinalCap")
                .font(.headline)
                .foregroundStyle(AppTheme.textPrimary)
            Spacer()

            PhotosPicker(
                selection: $photosPickerItem,
                matching: .videos,
                photoLibrary: .shared()
            ) {
                Text("Import")
                    .font(.subheadline.weight(.semibold))
            }
            .disabled(!importEnabled)
            .accessibilityLabel("Import")
            .accessibilityHint("Choose a video from Photos")

            if exportVisible {
                Button("Export", action: onExport)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppTheme.accent)
                    .disabled(!exportEnabled)
            }

            if showUpgrade {
                HStack(spacing: 6) {
                    if let freeRemaining {
                        Text("\(max(freeRemaining, 0)) free left")
                            .font(.caption2)
                            .foregroundStyle(AppTheme.textSecondary)
                            .accessibilityLabel("\(max(freeRemaining, 0)) free edits left today")
                    }
                    Button(action: onUpgrade) {
                        Label("Upgrade", systemImage: "crown.fill")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.black)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(AppTheme.accent)
                            .clipShape(Capsule())
                    }
                    .accessibilityIdentifier("Upgrade")
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(AppTheme.surface)
        .overlay(alignment: .bottom) {
            Rectangle().fill(AppTheme.border).frame(height: 1)
        }
        .accessibilityIdentifier("TopBar")
    }
}

#Preview {
    TopBarView(
        photosPickerItem: .constant(nil),
        onExport: {},
        onUpgrade: {},
        exportVisible: true,
        freeRemaining: 3
    )
}
