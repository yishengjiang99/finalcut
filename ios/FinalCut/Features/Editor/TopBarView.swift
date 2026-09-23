import SwiftUI

struct TopBarView: View {
    var onImport: () -> Void
    var onImportFiles: () -> Void
    var onExport: () -> Void
    var importEnabled = true
    var importLabel = "Import"

    var body: some View {
        HStack {
            Text("FinalCap")
                .font(.headline)
                .foregroundStyle(AppTheme.textPrimary)
            Spacer()
            Menu {
                Button("Photo Library", systemImage: "photo.on.rectangle", action: onImport)
                Button("Choose File", systemImage: "folder", action: onImportFiles)
            } label: {
                Text(importLabel)
            } primaryAction: {
                onImport()
            }
                .font(.subheadline.weight(.semibold))
                .disabled(!importEnabled)
                .accessibilityHint("Opens Photos. Touch and hold for more import options.")
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
    TopBarView(onImport: {}, onImportFiles: {}, onExport: {})
}
