import SwiftUI
import StoreKit

/// Paywall — StoreKit 2 In-App Purchase stub (NOT Stripe Checkout).
/// Presented as a sheet from the Editor (Upgrade button, or when the free usage limit is hit).
struct PaywallView: View {
    @EnvironmentObject private var appModel: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var statusMessage: String?
    @State private var isBusy = false

    var body: some View {
        VStack(spacing: 24) {
            HStack {
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title2)
                }
                .foregroundStyle(AppTheme.textSecondary)
                .accessibilityLabel("Close")
            }
            .padding(.horizontal)
            .padding(.top, 12)

            Spacer()

            VStack(spacing: 12) {
                Image(systemName: "crown.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(AppTheme.accent)
                Text(headline)
                    .font(.title.bold())
                    .foregroundStyle(AppTheme.textPrimary)
                    .multilineTextAlignment(.center)
                Text(appModel.isUnlimited
                     ? UXCopy.paywallSubheadUnlimited
                     : "Unlimited AI edits, captions and translations.\nMonthly subscription billed through the App Store.")
                    .font(.footnote)
                    .foregroundStyle(AppTheme.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }

            VStack(spacing: 12) {
                Button {
                    Task { await buy() }
                } label: {
                    Group {
                        if isBusy {
                            ProgressView()
                                .tint(.white)
                        } else {
                            Text("Subscribe")
                        }
                    }
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                }
                .buttonStyle(.borderedProminent)
                .tint(AppTheme.accent)
                .disabled(isBusy)

                Button {
                    Task { await restore() }
                } label: {
                    Text("Restore purchases")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }
                .buttonStyle(.bordered)
                .disabled(isBusy)

                Button("Not now") {
                    dismiss()
                }
                .font(.subheadline)
                .foregroundStyle(AppTheme.textSecondary)
            }
            .padding(.horizontal, 24)

            if let statusMessage {
                Text(statusMessage)
                    .font(.caption)
                    .foregroundStyle(AppTheme.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
            }

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AppTheme.background.ignoresSafeArea())
        .accessibilityIdentifier("Paywall")
        .task {
            // Warm product fetch; empty in simulator without StoreKit config is fine.
            let products = await StoreKitPurchaseStub.loadProducts()
            if products.isEmpty {
                statusMessage = "Subscriptions aren’t available right now."
            }
        }
    }

    private var headline: String {
        switch appModel.paywallReason {
        case .usageLimitReached:
            return "You've used today's free edits"
        case .upgradeTapped:
            return "Unlock FinalCap"
        }
    }

    private func buy() async {
        isBusy = true
        defer { isBusy = false }
        let outcome = await StoreKitPurchaseStub.purchaseMonthly()
        switch outcome {
        case .success(let jws):
            do {
                let status = try await appModel.apiClient.syncAppleTransaction(jwsRepresentation: jws)
                statusMessage = "Purchase verified."
                appModel.subscriptionActivated(status)
            } catch {
                statusMessage = "Purchase completed, but server verification is pending: \(error.localizedDescription)"
            }
        case .cancelled:
            statusMessage = "Purchase cancelled."
        case .pending:
            statusMessage = "Purchase pending approval."
        case .unavailable:
            statusMessage = "Product unavailable right now — please try again later."
        case .failed(let message):
            statusMessage = "Purchase failed: \(message)"
        }
    }

    private func restore() async {
        isBusy = true
        defer { isBusy = false }
        guard let jws = await StoreKitPurchaseStub.restoreEntitlementJWS() else {
            statusMessage = "No entitlement found (simulator without transactions is expected)."
            return
        }
        do {
            let status = try await appModel.apiClient.syncAppleTransaction(jwsRepresentation: jws)
            statusMessage = "Entitlement restored."
            appModel.subscriptionActivated(status)
        } catch {
            statusMessage = "Entitlement found, but server verification failed: \(error.localizedDescription)"
        }
    }
}

#Preview {
    PaywallView()
        .environmentObject(AppModel())
}
