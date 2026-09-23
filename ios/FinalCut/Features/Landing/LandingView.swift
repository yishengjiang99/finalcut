import SwiftUI

struct LandingView: View {
    @EnvironmentObject private var appModel: AppModel

    var body: some View {
        VStack(spacing: 28) {
            Spacer()
            VStack(spacing: 12) {
                Image(systemName: "film.stack")
                    .font(.system(size: 56, weight: .light))
                    .foregroundStyle(AppTheme.accent)
                Text("FinalCap")
                    .font(.largeTitle.bold())
                    .foregroundStyle(AppTheme.textPrimary)
                Text("AI video editing — native iOS shell")
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.textSecondary)
                    .multilineTextAlignment(.center)
            }
            Spacer()
            VStack(spacing: 12) {
                Button {
                    appModel.goToSignIn()
                } label: {
                    Text("Get started")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                }
                .buttonStyle(.borderedProminent)
                .tint(AppTheme.accent)

                Button("Try it now") {
                    appModel.tryTestVideoNow()
                }
                .font(.footnote)
                .foregroundStyle(AppTheme.textSecondary)

                Button("Open empty editor") {
                    appModel.skipToEditorForDev()
                }
                .font(.footnote)
                .foregroundStyle(AppTheme.textSecondary)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 40)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AppTheme.background.ignoresSafeArea())
        .navigationTitle("Landing")
        .accessibilityIdentifier("Landing")
    }
}

#Preview {
    LandingView()
        .environmentObject(AppModel())
}
