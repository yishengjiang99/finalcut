import SwiftUI
import StoreKit

/// Paywall — StoreKit 2 auto-renewable subscription (NOT Stripe Checkout).
/// Presented as a sheet from the Editor (Upgrade button, or when the free usage limit is hit).
/// Guideline 3.1.2: shows the subscription title, duration, localized price per period (from StoreKit),
/// Restore Purchases, the auto-renew terms, and working Terms of Use (EULA) + Privacy Policy links.
struct PaywallView: View {
    @EnvironmentObject private var appModel: AppModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var store: PaywallStore
    @State private var statusMessage: String?
    @State private var isBusy = false

    init(store: PaywallStore = PaywallStore()) {
        _store = StateObject(wrappedValue: store)
    }

    var body: some View {
        VStack(spacing: 0) {
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

            ScrollView {
                VStack(spacing: 22) {
                    header
                    planCard
                    actions
                    if let statusMessage {
                        Text(statusMessage)
                            .font(.caption)
                            .foregroundStyle(AppTheme.textSecondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)
                            .accessibilityIdentifier("PaywallStatus")
                    }
                    legal
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 12)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AppTheme.background.ignoresSafeArea())
        .accessibilityIdentifier("Paywall")
        .task { await store.load() }
    }

    // MARK: - Sections

    private var header: some View {
        VStack(spacing: 10) {
            Image(systemName: "crown.fill")
                .font(.system(size: 44))
                .foregroundStyle(AppTheme.accent)
            Text(headline)
                .font(.title.bold())
                .foregroundStyle(AppTheme.textPrimary)
                .multilineTextAlignment(.center)
            Text(appModel.isUnlimited
                 ? UXCopy.paywallSubheadUnlimited
                 : "Unlimited AI edits, captions and translations.")
                .font(.footnote)
                .foregroundStyle(AppTheme.textSecondary)
                .multilineTextAlignment(.center)
        }
        .padding(.top, 8)
    }

    @ViewBuilder
    private var planCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch store.state {
            case .loaded(let product):
                Text(product.displayName.isEmpty ? PaywallCopy.fallbackPlanName : product.displayName)
                    .font(.headline)
                    .foregroundStyle(AppTheme.textPrimary)
                    .accessibilityIdentifier("PaywallPlanTitle")
                if let period = product.subscription?.subscriptionPeriod {
                    Text(PaywallCopy.priceLine(displayPrice: product.displayPrice, value: period.value, unit: period.unit))
                        .font(.system(size: 30, weight: .bold))
                        .foregroundStyle(AppTheme.textPrimary)
                        .accessibilityIdentifier("PaywallPrice")
                    Text(PaywallCopy.durationLine(value: period.value, unit: period.unit))
                        .font(.subheadline)
                        .foregroundStyle(AppTheme.textSecondary)
                        .accessibilityIdentifier("PaywallDuration")
                } else {
                    Text(product.displayPrice)
                        .font(.system(size: 30, weight: .bold))
                        .foregroundStyle(AppTheme.textPrimary)
                        .accessibilityIdentifier("PaywallPrice")
                }
                benefits
            case .unavailable:
                Text(PaywallCopy.fallbackPlanName)
                    .font(.headline)
                    .foregroundStyle(AppTheme.textPrimary)
                Text(PaywallCopy.unavailableMessage)
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.textSecondary)
                    .accessibilityIdentifier("PaywallUnavailable")
            case .idle, .loading:
                HStack(spacing: 10) {
                    ProgressView().tint(AppTheme.textSecondary)
                    Text(PaywallCopy.loadingMessage)
                        .font(.subheadline)
                        .foregroundStyle(AppTheme.textSecondary)
                }
                .frame(maxWidth: .infinity, minHeight: 80)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: AppTheme.cornerRadius)
                .fill(AppTheme.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: AppTheme.cornerRadius)
                .stroke(AppTheme.accent.opacity(0.6), lineWidth: 1.5)
        )
    }

    private var benefits: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(PaywallCopy.benefits, id: \.self) { line in
                HStack(spacing: 8) {
                    Image(systemName: "checkmark")
                        .font(.caption.bold())
                        .foregroundStyle(AppTheme.accent)
                    Text(line)
                        .font(.subheadline)
                        .foregroundStyle(AppTheme.textPrimary)
                }
            }
        }
        .padding(.top, 4)
    }

    @ViewBuilder
    private var actions: some View {
        VStack(spacing: 12) {
            switch store.state {
            case .loaded(let product):
                Button {
                    Task { await buy(product) }
                } label: {
                    Group {
                        if isBusy {
                            ProgressView().tint(.white)
                        } else if let period = product.subscription?.subscriptionPeriod {
                            Text(PaywallCopy.subscribeButtonTitle(displayPrice: product.displayPrice,
                                                                  value: period.value, unit: period.unit))
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
                .accessibilityIdentifier("PaywallSubscribe")
            case .unavailable:
                Button {
                    statusMessage = nil
                    Task { await store.retry() }
                } label: {
                    Text("Try Again")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                }
                .buttonStyle(.borderedProminent)
                .tint(AppTheme.accent)
                .accessibilityIdentifier("PaywallRetry")
            case .idle, .loading:
                EmptyView()
            }

            Button {
                Task { await restore() }
            } label: {
                Text("Restore Purchases")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
            }
            .buttonStyle(.bordered)
            .disabled(isBusy)
            .accessibilityIdentifier("PaywallRestore")

            Button("Not now") {
                dismiss()
            }
            .font(.subheadline)
            .foregroundStyle(AppTheme.textSecondary)
        }
    }

    private var legal: some View {
        VStack(spacing: 10) {
            Text(PaywallCopy.autoRenewNotice)
                .font(.caption2)
                .foregroundStyle(AppTheme.textSecondary)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("PaywallAutoRenew")
            HStack(spacing: 24) {
                Link("Terms of Use", destination: PaywallCopy.termsOfUseURL)
                    .accessibilityIdentifier("PaywallTerms")
                Link("Privacy Policy", destination: PaywallCopy.privacyPolicyURL)
                    .accessibilityIdentifier("PaywallPrivacy")
            }
            .font(.caption)
            .tint(AppTheme.accent)
        }
        .padding(.bottom, 12)
    }

    private var headline: String {
        switch appModel.paywallReason {
        case .usageLimitReached:
            return "You've used today's free edits"
        case .upgradeTapped:
            return PaywallCopy.title
        }
    }

    // MARK: - Actions

    private func buy(_ product: Product) async {
        isBusy = true
        defer { isBusy = false }
        let outcome = await StoreKitPurchaseStub.purchase(product)
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
            statusMessage = PaywallCopy.unavailableMessage
        case .failed(let message):
            statusMessage = "Purchase failed: \(message)"
        }
    }

    private func restore() async {
        isBusy = true
        defer { isBusy = false }
        guard let jws = await StoreKitPurchaseStub.restoreEntitlementJWS(syncWithAppStore: true) else {
            statusMessage = PaywallCopy.restoreNothingFound
            return
        }
        do {
            let status = try await appModel.apiClient.syncAppleTransaction(jwsRepresentation: jws)
            statusMessage = "Subscription restored."
            appModel.subscriptionActivated(status)
        } catch {
            statusMessage = "Subscription found, but server verification failed: \(error.localizedDescription)"
        }
    }
}

#Preview {
    PaywallView()
        .environmentObject(AppModel())
}
