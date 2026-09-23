import SwiftUI
import StoreKit

/// Paywall — StoreKit 2 In-App Purchase stub (NOT Stripe Checkout).
struct PaywallView: View {
    @EnvironmentObject private var appModel: AppModel
    @State private var statusMessage: String?
    @State private var isBusy = false

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
                Text("Unlock FinalCap")
                    .font(.title.bold())
                    .foregroundStyle(AppTheme.textPrimary)
                Text("StoreKit 2 In-App Purchase stub.\nProduct: \(StoreKitPurchaseStub.monthlyProductID)\nDoes not open Stripe URLs.")
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
                            Text("Subscribe (StoreKit)")
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

                Button("Continue without purchase (local demo)") {
                    appModel.unlockEditor()
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
                statusMessage = "No StoreKit products loaded (add a StoreKit Configuration or App Store Connect product)."
            }
        }
    }

    private func buy() async {
        isBusy = true
        defer { isBusy = false }
        let outcome = await StoreKitPurchaseStub.purchaseMonthly()
        switch outcome {
        case .success(let jws):
            do {
                _ = try await appModel.apiClient.syncAppleTransaction(jwsRepresentation: jws)
                statusMessage = "Purchase verified."
                appModel.unlockEditor()
            } catch {
                statusMessage = "Purchase completed, but server verification is pending: \(error.localizedDescription)"
            }
        case .cancelled:
            statusMessage = "Purchase cancelled."
        case .pending:
            statusMessage = "Purchase pending approval."
        case .unavailable:
            statusMessage = "Product unavailable — continuing local demo."
            appModel.unlockEditor()
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
            _ = try await appModel.apiClient.syncAppleTransaction(jwsRepresentation: jws)
            statusMessage = "Entitlement restored."
            appModel.unlockEditor()
        } catch {
            statusMessage = "Entitlement found, but server verification failed: \(error.localizedDescription)"
        }
    }
}

#Preview {
    PaywallView()
        .environmentObject(AppModel())
}
