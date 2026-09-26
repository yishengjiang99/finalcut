import SwiftUI
import UIKit

/// Suggestion pills: shows each pill's label (and SF Symbol when valid); tapping sends its prompt.
struct SampleChipsView: View {
    var pills: [SuggestionPill]
    var onSelect: (SuggestionPill) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(pills) { pill in
                    Button {
                        onSelect(pill)
                    } label: {
                        HStack(spacing: 4) {
                            if let icon = pill.icon, UIImage(systemName: icon) != nil {
                                Image(systemName: icon)
                                    .accessibilityHidden(true)
                            }
                            Text(pill.label)
                        }
                        .font(.caption.weight(.medium))
                        .foregroundStyle(AppTheme.textPrimary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(AppTheme.surfaceElevated)
                        .clipShape(Capsule())
                        .overlay(
                            Capsule().stroke(AppTheme.border, lineWidth: 1)
                        )
                    }
                    .accessibilityLabel(pill.label)
                    .accessibilityIdentifier("suggestion-\(pill.id)")
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(AppTheme.surface)
        .accessibilityIdentifier("SampleChips")
    }
}

#Preview {
    SampleChipsView(pills: SuggestionService.bundledVideo, onSelect: { _ in })
}
