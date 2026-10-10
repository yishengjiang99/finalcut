import Foundation
import StoreKit

/// StoreKit 2 purchase helpers for the FinalCap Pro subscription (not Stripe).
/// Product, group and price must match App Store Connect (scripts/asc/create_subscriptions.py)
/// and the local `StoreKit/FinalCut.storekit` configuration.
enum StoreKitPurchaseStub {
    /// Auto-renewable, 1 month, group "FinalCap Pro".
    static let monthlyProductID = "com.ragnus.w2.subscription.monthly"

    /// Loads products via StoreKit 2. Returns empty if unavailable (no network / not configured).
    static func loadProducts() async -> [Product] {
        do {
            return try await Product.products(for: [monthlyProductID])
        } catch {
            return []
        }
    }

    /// Attempts purchase of the monthly product (loads it first).
    @discardableResult
    static func purchaseMonthly() async -> PurchaseOutcome {
        let products = await loadProducts()
        guard let product = products.first(where: { $0.id == monthlyProductID }) ?? products.first else {
            return .unavailable
        }
        return await purchase(product)
    }

    /// Purchases an already-loaded product.
    static func purchase(_ product: Product) async -> PurchaseOutcome {
        do {
            let result = try await product.purchase(options: [.appAccountToken(DeviceIdentity.installUUID)])
            switch result {
            case .success(let verification):
                let jws = verification.jwsRepresentation
                let transaction = try checkVerified(verification)
                await transaction.finish()
                return .success(jws)
            case .userCancelled:
                return .cancelled
            case .pending:
                return .pending
            @unknown default:
                return .unavailable
            }
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    /// Restore Purchases: syncs with the App Store (may ask the user to sign in), then reads current entitlements.
    static func restoreEntitlementJWS(syncWithAppStore: Bool = false) async -> String? {
        if syncWithAppStore {
            try? await AppStore.sync()
        }
        for await result in Transaction.currentEntitlements {
            if case .verified(let transaction) = result,
               transaction.productID == monthlyProductID {
                return result.jwsRepresentation
            }
        }
        return nil
    }

    static func restoreEntitlements() async -> Bool {
        await restoreEntitlementJWS() != nil
    }

    /// True if an active entitlement exists for the subscription.
    static func hasActiveEntitlement() async -> Bool {
        await restoreEntitlements()
    }

    private static func checkVerified<T>(_ result: VerificationResult<T>) throws -> T {
        switch result {
        case .unverified(_, let error):
            throw error
        case .verified(let safe):
            return safe
        }
    }

    enum PurchaseOutcome: Equatable {
        case success(String)
        case cancelled
        case pending
        case unavailable
        case failed(String)
    }
}

/// Paywall copy and links required by App Review guideline 3.1.2 (auto-renewable subscriptions).
enum PaywallCopy {
    static let title = "FinalCap Pro"
    static let fallbackPlanName = "FinalCap Pro Monthly"
    static let benefits = [
        "Unlimited AI edits",
        "Captions and translations",
        "Everything in the free version",
    ]
    static let autoRenewNotice = "Payment charged to your Apple ID. Renews automatically unless canceled at least 24 hours before the end of the period. Manage in Settings."
    static let termsOfUseURL = URL(string: "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")!
    static let privacyPolicyURL = URL(string: "https://grepawk.com/legal/privacy.html")!
    static let loadingMessage = "Loading subscription…"
    static let unavailableMessage = "Couldn't load the subscription from the App Store. Check your connection and tap Try Again."
    static let restoreNothingFound = "No active FinalCap Pro subscription was found for this Apple ID."

    /// "month", "3 months", "year" — used in "$9.99 / month".
    static func periodUnitText(value: Int, unit: Product.SubscriptionPeriod.Unit) -> String {
        let word: String
        switch unit {
        case .day: word = "day"
        case .week: word = "week"
        case .month: word = "month"
        case .year: word = "year"
        @unknown default: word = "period"
        }
        return value == 1 ? word : "\(value) \(word)s"
    }

    /// "1 month", "3 months", "1 year" — the subscription duration.
    static func durationText(value: Int, unit: Product.SubscriptionPeriod.Unit) -> String {
        let text = periodUnitText(value: value, unit: unit)
        return value == 1 ? "1 \(text)" : text
    }

    /// "$9.99 / month"
    static func priceLine(displayPrice: String, value: Int, unit: Product.SubscriptionPeriod.Unit) -> String {
        "\(displayPrice) / \(periodUnitText(value: value, unit: unit))"
    }

    /// "Auto-renewing subscription · 1 month"
    static func durationLine(value: Int, unit: Product.SubscriptionPeriod.Unit) -> String {
        "Auto-renewing subscription · \(durationText(value: value, unit: unit))"
    }

    static func subscribeButtonTitle(displayPrice: String, value: Int, unit: Product.SubscriptionPeriod.Unit) -> String {
        "Subscribe for \(displayPrice)/\(periodUnitText(value: value, unit: unit))"
    }
}

/// Loads the subscription product for the paywall with explicit loading / loaded / unavailable states,
/// so an empty product list shows a message and a Try Again button instead of a dead Subscribe button.
@MainActor
final class PaywallStore: ObservableObject {
    enum LoadState: Equatable {
        case idle
        case loading
        case loaded(Product)
        case unavailable

        static func == (lhs: LoadState, rhs: LoadState) -> Bool {
            switch (lhs, rhs) {
            case (.idle, .idle), (.loading, .loading), (.unavailable, .unavailable): return true
            case let (.loaded(a), .loaded(b)): return a.id == b.id
            default: return false
            }
        }
    }

    @Published private(set) var state: LoadState = .idle
    @Published private(set) var loadAttempts = 0

    private let loader: () async -> [Product]
    private let retryDelays: [UInt64]

    /// - Parameters:
    ///   - loader: product fetch (StoreKit by default; injectable for tests).
    ///   - retryDelaysNanos: automatic retries after an empty result before showing the unavailable state.
    init(loader: @escaping () async -> [Product] = StoreKitPurchaseStub.loadProducts,
         retryDelaysNanos: [UInt64] = [1_000_000_000, 2_000_000_000]) {
        self.loader = loader
        self.retryDelays = retryDelaysNanos
    }

    var product: Product? {
        if case .loaded(let p) = state { return p }
        return nil
    }

    /// Loads the product, retrying automatically a couple of times; ends in `.loaded` or `.unavailable`.
    func load() async {
        if case .loading = state { return }
        state = .loading
        var delays = retryDelays[...]
        while true {
            loadAttempts += 1
            let products = await loader()
            if let p = products.first(where: { $0.id == StoreKitPurchaseStub.monthlyProductID }) ?? products.first {
                state = .loaded(p)
                return
            }
            guard let delay = delays.popFirst() else { break }
            try? await Task.sleep(nanoseconds: delay)
        }
        state = .unavailable
    }

    /// Try Again button.
    func retry() async {
        state = .idle
        await load()
    }
}
