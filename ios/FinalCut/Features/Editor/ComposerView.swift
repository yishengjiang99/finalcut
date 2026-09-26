import SwiftUI
import PhotosUI
import UIKit

struct ComposerView: View {
    @Binding var text: String
    @Binding var photosPickerItem: PhotosPickerItem?
    var onSend: () -> Void
    var importEnabled = true
    /// On-device dictation; nil hides the mic (previews/tests).
    var dictation: DictationController? = nil

    @FocusState private var fieldFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .bottom, spacing: 10) {
                PhotosPicker(
                    selection: $photosPickerItem,
                    matching: EditorViewModel.pickerFilter,
                    photoLibrary: .shared()
                ) {
                    Image(systemName: "plus.circle.fill")
                        .font(.title2)
                        .foregroundStyle(AppTheme.accent)
                }
                .accessibilityLabel("Import")
                .accessibilityHint("Choose a photo or video from Photos")
                .disabled(!importEnabled)
                .opacity(importEnabled ? 1 : 0.35)

                TextField(isListening ? UXCopy.dictationListening : "Describe an edit…", text: $text, axis: .vertical)
                    .lineLimit(1...5)
                    .padding(10)
                    .background(AppTheme.surfaceElevated)
                    .clipShape(RoundedRectangle(cornerRadius: AppTheme.cornerRadius))
                    .foregroundStyle(AppTheme.textPrimary)
                    .focused($fieldFocused)
                    .onChange(of: fieldFocused) { _, focused in
                        // Tapping the field stops listening; the text stays unsent.
                        if focused, isListening { dictation?.stop() }
                    }

                trailingButton
            }
            if let note = dictationNote {
                HStack(spacing: 6) {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(AppTheme.textSecondary)
                    if dictation?.status == .permissionDenied {
                        Button("Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) {
                                UIApplication.shared.open(url)
                            }
                        }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AppTheme.accent)
                    }
                }
                .accessibilityIdentifier("DictationNote")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(AppTheme.surface)
        .overlay(alignment: .top) {
            Rectangle().fill(AppTheme.border).frame(height: 1)
        }
        .accessibilityIdentifier("Composer")
    }

    private var isListening: Bool { dictation?.isListening == true }
    private var hasText: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private var dictationNote: String? {
        switch dictation?.status {
        case .permissionDenied: return UXCopy.dictationPermissionDenied
        case .unavailable: return UXCopy.dictationUnavailable
        default: return nil
        }
    }

    /// Mic and Send share one slot: Send when there's typed text, stop while listening.
    @ViewBuilder
    private var trailingButton: some View {
        if isListening, let dictation {
            DictationStopButton { dictation.stop() }
        } else if hasText || dictation == nil {
            Button(action: onSend) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title2)
                    .foregroundStyle(hasText ? AppTheme.accent : AppTheme.textSecondary)
            }
            .disabled(!hasText)
            .accessibilityLabel("Send")
        } else if let dictation {
            Button {
                fieldFocused = false
                dictation.toggle()
            } label: {
                Image(systemName: "mic.fill")
                    .font(.title3)
                    .foregroundStyle(dictation.isSupported ? AppTheme.accent : AppTheme.textSecondary)
                    .frame(width: 30, height: 30)
            }
            .opacity(dictation.isSupported ? 1 : 0.45)
            .accessibilityLabel("Dictate")
            .accessibilityIdentifier("DictationMic")
        }
    }
}

/// Red stop button with a pulsing ring while listening.
private struct DictationStopButton: View {
    var action: () -> Void
    @State private var pulse = false

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .stroke(Color.red.opacity(0.5), lineWidth: 2)
                    .frame(width: 34, height: 34)
                    .scaleEffect(pulse ? 1.25 : 0.9)
                    .opacity(pulse ? 0 : 1)
                Circle()
                    .fill(Color.red)
                    .frame(width: 30, height: 30)
                RoundedRectangle(cornerRadius: 2)
                    .fill(Color.white)
                    .frame(width: 10, height: 10)
            }
        }
        .accessibilityLabel("Stop dictation")
        .accessibilityIdentifier("DictationStop")
        .onAppear {
            withAnimation(.easeOut(duration: 1.1).repeatForever(autoreverses: false)) { pulse = true }
        }
    }
}

#Preview {
    ComposerView(text: .constant(""), photosPickerItem: .constant(nil), onSend: {})
}
