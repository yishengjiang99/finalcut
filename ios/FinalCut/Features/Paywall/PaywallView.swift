import SwiftUI
import StoreKit

/// Paywall placeholder — StoreKit vs Stripe still open.
struct PaywallView: View {
    @EnvironmentObject private var appModel: AppModel

    var body: some View {
        VStack(spacing: 24) {
            HStack {
                Button {
                    appModel.route = .signIn
                } label: {
                    Image(systemName: "chevron.left")
                    Text("Back")
                }
                .foregroundStyle(AppTheme.textSecondary)
                Spacer()
            }
            .padding(.horizontal)

            Spacer()

            VStack(spacing: 12) {
                Image(systemName: "crown.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(AppTheme.accent)
                Text("Unlock FinalCut")
                    .font(.title.bold())
                    .foregroundStyle(AppTheme.textPrimary)
                Text("StoreKit placeholder. Server Stripe checkout (`/api/create-checkout-session`) remains available.")
                    .font(.footnote)
                    .foregroundStyle(AppTheme.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }

            VStack(spacing: 12) {
                Button {
                    // StoreKit purchase stub
                    appModel.unlockEditor()
                } label: {
                    Text("Subscribe (StoreKit stub)")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                }
                .buttonStyle(.borderedProminent)
                .tint(AppTheme.accent)

                Button("Continue free / already paid") {
                    appModel.unlockEditor()
                }
                .font(.subheadline)
                .foregroundStyle(AppTheme.textSecondary)
            }
            .padding(.horizontal, 24)

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AppTheme.background.ignoresSafeArea())
        .accessibilityIdentifier("Paywall")
    }
}

#Preview {
    PaywallView()
        .environmentObject(AppModel())
}
