import SwiftUI

/// Placeholder SignIn — account sign-in deferred (product decision).
/// Non-functional auth; local demo can continue into Paywall / Editor.
struct SignInView: View {
    @EnvironmentObject private var appModel: AppModel

    var body: some View {
        VStack(spacing: 24) {
            HStack {
                Button {
                    appModel.route = .landing
                } label: {
                    Image(systemName: "chevron.left")
                    Text("Back")
                }
                .foregroundStyle(AppTheme.textSecondary)
                Spacer()
            }
            .padding(.horizontal)

            Spacer()

            VStack(spacing: 8) {
                Text("Sign in")
                    .font(.title.bold())
                    .foregroundStyle(AppTheme.textPrimary)
                Text("Account sign-in is not available yet.\nContinue for a local demo of the editor shell.")
                    .font(.footnote)
                    .foregroundStyle(AppTheme.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
            }

            VStack(spacing: 12) {
                Button {
                    // Local demo path into Paywall → Editor (no auth).
                    appModel.completeSignIn(sampleMode: false)
                } label: {
                    Text("Continue to editor (local demo)")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                }
                .buttonStyle(.borderedProminent)
                .tint(AppTheme.accent)

                #if DEBUG
                Button {
                    Task { await enterSampleMode() }
                } label: {
                    Text("Continue with sample mode (DEBUG)")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }
                .buttonStyle(.bordered)
                .tint(AppTheme.textSecondary)
                #endif
            }
            .padding(.horizontal, 24)

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AppTheme.background.ignoresSafeArea())
        .accessibilityIdentifier("SignIn")
    }

    #if DEBUG
    @State private var sampleError: String?

    private func enterSampleMode() async {
        do {
            _ = try await appModel.apiClient.fetchSampleAccessToken()
        } catch {
            // Offline / endpoint unavailable — still allow demo UI.
        }
        appModel.completeSignIn(sampleMode: true)
    }
    #endif
}

#Preview {
    SignInView()
        .environmentObject(AppModel())
}
