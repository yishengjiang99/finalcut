import SwiftUI

/// Settings sheet (tap the FinalCap title). Cloud processing is opt-in; off means nothing is
/// ever uploaded and edits the iPhone can't do yet show "Not available on iPhone yet".
struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage(NativeSettings.cloudProcessingKey) private var cloudProcessing = false
    @ObservedObject private var push = PushManager.shared
    @Environment(\.openURL) private var openURL

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
                Section {
                    Toggle("Tips & offers", isOn: Binding(
                        get: { push.marketingOptIn },
                        set: { push.setMarketingOptIn($0) }
                    ))
                    .tint(AppTheme.accent)
                    .disabled(!PushManager.isAllowed(push.authorization))
                    .accessibilityIdentifier("TipsAndOffersToggle")
                    if push.authorization == .notDetermined {
                        // iOS Settings has no FinalCap notification switch until the app has asked once.
                        Button("Turn on notifications") { push.requestPermission() }
                            .accessibilityIdentifier("TurnOnNotifications")
                    } else {
                        Button("Notification settings") {
                            if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
                        }
                    }
                } header: {
                    Text("Notifications")
                } footer: {
                    Text(PushManager.isAllowed(push.authorization)
                         ? "Editing tips and export alerts are on. Tips & offers adds occasional feature news and FinalCap Pro offers, at most a few a week. Off by default."
                         : push.authorization == .notDetermined
                         ? "Turn on notifications to get export alerts and editing tips."
                         : "Notifications are off. Turn them on in iOS Settings to get export alerts and editing tips.")
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
