import SwiftUI

/// Placeholder SignIn — Google vs Apple still open (Design).
struct SignInView: View {
    @EnvironmentObject private var appModel: AppModel
    @State private var isBusy = false
    @State private var errorMessage: String?

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
                Text("Provider TBD — Google vs Apple still open.\nBearer token via mobile Google stub when ready.")
                    .font(.footnote)
                    .foregroundStyle(AppTheme.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
            }

            VStack(spacing: 12) {
                Button {
                    // Stub: would obtain Google ID token then call APIClient.authenticateWithGoogle
                    appModel.completeSignIn(sampleMode: false)
                } label: {
                    Label("Continue with Google (stub)", systemImage: "g.circle.fill")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }
                .buttonStyle(.borderedProminent)
                .tint(AppTheme.accent)
                .disabled(isBusy)

                Button {
                    appModel.completeSignIn(sampleMode: false)
                } label: {
                    Label("Continue with Apple (stub)", systemImage: "apple.logo")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }
                .buttonStyle(.bordered)
                .disabled(isBusy)

                #if DEBUG
                Button {
                    Task { await enterSampleMode() }
                } label: {
                    Text("Try sample mode (DEBUG)")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }
                .buttonStyle(.bordered)
                .tint(AppTheme.textSecondary)
                .disabled(isBusy)
                #endif
            }
            .padding(.horizontal, 24)

            if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(AppTheme.danger)
                    .padding(.horizontal)
            }

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AppTheme.background.ignoresSafeArea())
        .accessibilityIdentifier("SignIn")
    }

    #if DEBUG
    private func enterSampleMode() async {
        isBusy = true
        defer { isBusy = false }
        do {
            _ = try await appModel.apiClient.fetchSampleAccessToken()
            appModel.completeSignIn(sampleMode: true)
        } catch {
            // Still allow continuing in sample UI even if endpoint fails offline.
            errorMessage = "Sample token fetch failed — continuing in demo UI."
            appModel.completeSignIn(sampleMode: true)
        }
    }
    #endif
}

#Preview {
    SignInView()
        .environmentObject(AppModel())
}
