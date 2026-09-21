import SwiftUI

struct SampleChipsView: View {
    var chips: [String]
    var onSelect: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(chips, id: \.self) { chip in
                    Button {
                        onSelect(chip)
                    } label: {
                        Text(chip)
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
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .background(AppTheme.surface)
        .accessibilityIdentifier("SampleChips")
    }
}

#Preview {
    SampleChipsView(chips: ["Trim", "Captions"], onSelect: { _ in })
}
