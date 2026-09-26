import SwiftUI
import PhotosUI

struct ComposerView: View {
    @Binding var text: String
    @Binding var photosPickerItem: PhotosPickerItem?
    var onSend: () -> Void
    var importEnabled = true

    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            PhotosPicker(
                selection: $photosPickerItem,
                matching: .videos,
                photoLibrary: .shared()
            ) {
                Image(systemName: "plus.circle.fill")
                    .font(.title2)
                    .foregroundStyle(AppTheme.accent)
            }
            .accessibilityLabel("Import")
            .accessibilityHint("Choose a video from Photos")
            .disabled(!importEnabled)
            .opacity(importEnabled ? 1 : 0.35)

            TextField("Describe an edit…", text: $text, axis: .vertical)
                .lineLimit(1...5)
                .padding(10)
                .background(AppTheme.surfaceElevated)
                .clipShape(RoundedRectangle(cornerRadius: AppTheme.cornerRadius))
                .foregroundStyle(AppTheme.textPrimary)

            Button(action: onSend) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title2)
                    .foregroundStyle(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                     ? AppTheme.textSecondary
                                     : AppTheme.accent)
            }
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("Send")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(AppTheme.surface)
        .overlay(alignment: .top) {
            Rectangle().fill(AppTheme.border).frame(height: 1)
        }
        .accessibilityIdentifier("Composer")
    }
}

#Preview {
    ComposerView(text: .constant(""), photosPickerItem: .constant(nil), onSend: {})
}
