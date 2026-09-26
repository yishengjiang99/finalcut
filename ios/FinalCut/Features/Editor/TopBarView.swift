import SwiftUI
import PhotosUI

/// Dark chrome top bar: title (leading) · Undo/Redo · Import (Photos) · Export (when a clip
/// is loaded) · Upgrade (trailing). One row at 375 pt: the title collapses to its gear and the
/// free counter disappears before anything wraps; the Upgrade capsule never wraps.
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
    /// Undo/Redo show once media is loaded; each is disabled when there's nothing to undo/redo.
    var editControlsVisible = false
    var canUndo = false
    var canRedo = false
    var onUndo: () -> Void = {}
    var onRedo: () -> Void = {}

    static let spacing: CGFloat = 8
    static let horizontalPadding: CGFloat = 12

    /// The free counter shows only with a real remaining count and no unlimited period.
    static func visibleFreeRemaining(unlimited: Bool, remaining: Int?) -> Int? {
        unlimited ? nil : remaining
    }

    /// Single ~44 pt row; the Upgrade capsule never wraps, the free-count label gives way first.
    static let rowHeight: CGFloat = 44

    var body: some View {
        HStack(spacing: Self.spacing) {
            // Title doubles as the Settings entry; when space is tight only the gear shows (Design §7).
            Button(action: onSettings) {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 4) {
                        Text("FinalCap")
                            .font(.headline)
                            .lineLimit(1)
                            .fixedSize()
                        Image(systemName: "gearshape")
                            .font(.caption)
                    }
                    Image(systemName: "gearshape")
                        .font(.body)
                }
                .foregroundStyle(AppTheme.textPrimary)
            }
            .accessibilityLabel("Settings")
            .accessibilityIdentifier("Settings")
            Spacer(minLength: 0)

            if editControlsVisible {
                HStack(spacing: 0) {
                    UndoRedoButton(systemImage: "arrow.uturn.backward", label: UXCopy.undo,
                                   enabled: canUndo, action: onUndo)
                        .accessibilityIdentifier("Undo")
                    UndoRedoButton(systemImage: "arrow.uturn.forward", label: UXCopy.redo,
                                   enabled: canRedo, action: onRedo)
                        .accessibilityIdentifier("Redo")
                }
                .layoutPriority(1)
            }

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
                HStack(spacing: 4) {
                    if let freeRemaining {
                        FreeRemainingLabel(count: max(freeRemaining, 0))
                            .layoutPriority(-1)
                    }
                    UpgradeCapsuleButton(action: onUpgrade)
                        .layoutPriority(1)
                }
            }
        }
        .padding(.horizontal, Self.horizontalPadding)
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

/// Icon-only Undo / Redo with a VoiceOver label; dimmed when disabled.
struct UndoRedoButton: View {
    var systemImage: String
    var label: String
    var enabled: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.subheadline.weight(.semibold))
                .frame(width: 28, height: 34)
                .contentShape(Rectangle())
        }
        .foregroundStyle(enabled ? AppTheme.textPrimary : AppTheme.textSecondary.opacity(0.5))
        .disabled(!enabled)
        .accessibilityLabel(label)
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
            .padding(.horizontal, 10)
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
            // Nothing when even that doesn't fit: Undo/Redo, Import, Export and Upgrade win.
            Color.clear.frame(width: 0, height: 0)
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
        freeRemaining: 3,
        editControlsVisible: true,
        canUndo: true
    )
}
