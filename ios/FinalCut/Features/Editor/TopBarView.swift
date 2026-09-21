import SwiftUI

struct TopBarView: View {
    var onImport: () -> Void
    var onExport: () -> Void

    var body: some View {
        HStack {
            Text("FinalCap")
                .font(.headline)
                .foregroundStyle(AppTheme.textPrimary)
            Spacer()
            Button("Import", action: onImport)
                .font(.subheadline.weight(.semibold))
            Button("Export", action: onExport)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppTheme.accent)
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
    TopBarView(onImport: {}, onExport: {})
}
