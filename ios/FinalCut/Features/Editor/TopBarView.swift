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
    var onSettings: () -> Void = {}

    /// Single ~44 pt row; the Upgrade capsule never wraps, the free-count label gives way first.
    static let rowHeight: CGFloat = 44

    var body: some View {
        HStack(spacing: 12) {
            // Title doubles as the Settings entry; it truncates before Import/Export (Design §7).
            Button(action: onSettings) {
                HStack(spacing: 4) {
                    Text("FinalCap")
                        .font(.headline)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Image(systemName: "gearshape")
                        .font(.caption)
                }
                .foregroundStyle(AppTheme.textPrimary)
            }
            .accessibilityLabel("Settings")
            .accessibilityIdentifier("Settings")
            Spacer(minLength: 4)

            PhotosPicker(
                selection: $photosPickerItem,
                matching: EditorViewModel.pickerFilter,
                photoLibrary: .shared()
            ) {
                Text("Import")
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
            }
            .disabled(!importEnabled)
            .accessibilityLabel("Import")
            .accessibilityHint("Choose a photo or video from Photos")

            if exportVisible {
                Button(action: onExport) {
                    Text("Export")
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                }
                .foregroundStyle(AppTheme.accent)
                .disabled(!exportEnabled)
            }

            if showUpgrade {
                if let freeRemaining {
                    FreeRemainingLabel(count: max(freeRemaining, 0))
                        .layoutPriority(-1)
                }
                UpgradeCapsuleButton(action: onUpgrade)
                    .layoutPriority(1)
            }
        }
        .padding(.horizontal, 16)
        .frame(minHeight: Self.rowHeight)
        .background(AppTheme.surface)
        .overlay(alignment: .bottom) {
            Rectangle().fill(AppTheme.border).frame(height: 1)
        }
        // Keep the chrome one row: Dynamic Type is honoured up to .xLarge here.
        .dynamicTypeSize(...DynamicTypeSize.xLarge)
        .accessibilityIdentifier("TopBar")
    }
}

/// Compact crown + "Upgrade" capsule (never wraps).
struct UpgradeCapsuleButton: View {
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: "crown.fill")
                Text("Upgrade")
            }
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .foregroundStyle(.black)
            .padding(.horizontal, 12)
            .frame(height: 34)
            .background(AppTheme.accent)
            .clipShape(Capsule())
        }
        .accessibilityIdentifier("Upgrade")
    }
}

/// "N free left", shrinking first and falling back to "N left" when space is tight.
struct FreeRemainingLabel: View {
    var count: Int

    var body: some View {
        ViewThatFits(in: .horizontal) {
            label("\(count) free left")
            label("\(count) left")
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(count) free edits left today")
    }

    private func label(_ text: String) -> some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(AppTheme.textSecondary)
            .lineLimit(1)
            .minimumScaleFactor(0.75)
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
