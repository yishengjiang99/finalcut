import SwiftUI

/// Settings sheet (tap the FinalCap title). Cloud processing is opt-in; off means nothing is
/// ever uploaded and edits the iPhone can't do yet show "Not available on iPhone yet".
struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage(NativeSettings.cloudProcessingKey) private var cloudProcessing = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle(UXCopy.cloudSettingTitle, isOn: $cloudProcessing)
                        .tint(AppTheme.accent)
                        .accessibilityIdentifier("CloudProcessingToggle")
                } footer: {
                    Text(UXCopy.cloudSettingFootnote)
                }
                Section("Privacy") {
                    Text(UXCopy.privacyFirstRun)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

#Preview {
    SettingsView()
}
