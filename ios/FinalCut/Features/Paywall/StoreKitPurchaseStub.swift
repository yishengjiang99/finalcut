import Foundation
import StoreKit

/// StoreKit 2 placeholders for FinalCut subscription (not Stripe).
enum StoreKitPurchaseStub {
    /// Placeholder product id — configure in App Store Connect / StoreKit Configuration file.
    static let monthlyProductID = "com.grepawk.finalcut.subscription.monthly"

    /// Loads products via StoreKit 2. Returns empty if unavailable (simulator without config).
    static func loadProducts() async -> [Product] {
        do {
            return try await Product.products(for: [monthlyProductID])
        } catch {
            return []
        }
    }

    /// Attempts purchase of the monthly product. No-ops gracefully when product missing.
    @discardableResult
    static func purchaseMonthly() async -> PurchaseOutcome {
        let products = await loadProducts()
        guard let product = products.first(where: { $0.id == monthlyProductID }) ?? products.first else {
            return .unavailable
        }
        do {
            let result = try await product.purchase()
            switch result {
            case .success(let verification):
                let transaction = try checkVerified(verification)
                await transaction.finish()
                return .success
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

    /// Restores via current entitlements (StoreKit 2).
    static func restoreEntitlements() async -> Bool {
        var found = false
        for await result in Transaction.currentEntitlements {
            if case .verified(let transaction) = result,
               transaction.productID == monthlyProductID {
                found = true
            }
        }
        return found
    }

    /// True if an active entitlement exists for the placeholder product.
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
        case success
        case cancelled
        case pending
        case unavailable
        case failed(String)
    }
}
