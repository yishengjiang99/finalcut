import StoreKit
import StoreKitTest
import XCTest
@testable import FinalCut

/// Guideline 3.1.2 paywall requirements + the StoreKit configuration matching App Store Connect.
final class PaywallTests: XCTestCase {
    private static var iosDir: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }
    private static var storeKitFile: URL {
        iosDir.appendingPathComponent("FinalCut/StoreKit/FinalCut.storekit")
    }

    func testAutoRenewNoticeAndLegalLinks() {
        XCTAssertEqual(PaywallCopy.autoRenewNotice,
                       "Payment charged to your Apple ID. Renews automatically unless canceled at least 24 hours before the end of the period. Manage in Settings.")
        XCTAssertEqual(PaywallCopy.termsOfUseURL.absoluteString,
                       "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")
        XCTAssertEqual(PaywallCopy.privacyPolicyURL.absoluteString, "https://grepawk.com/legal/privacy.html")
        XCTAssertEqual(StoreKitPurchaseStub.monthlyProductID, "com.ragnus.w2.subscription.monthly")
        XCTAssertFalse(PaywallCopy.unavailableMessage.isEmpty)
    }

    func testPriceAndDurationFormatting() {
        XCTAssertEqual(PaywallCopy.priceLine(displayPrice: "$9.99", value: 1, unit: .month), "$9.99 / month")
        XCTAssertEqual(PaywallCopy.durationText(value: 1, unit: .month), "1 month")
        XCTAssertEqual(PaywallCopy.durationText(value: 3, unit: .month), "3 months")
        XCTAssertEqual(PaywallCopy.durationText(value: 1, unit: .year), "1 year")
        XCTAssertEqual(PaywallCopy.durationLine(value: 1, unit: .month), "Auto-renewing subscription · 1 month")
        XCTAssertEqual(PaywallCopy.subscribeButtonTitle(displayPrice: "9,99 €", value: 1, unit: .month),
                       "Subscribe for 9,99 €/month")
    }

    /// The local .storekit mirrors ASC (scripts/asc/create_subscriptions.py): FinalCap naming, $9.99, 1 month,
    /// group "FinalCap Pro", level 1, Family Sharing off, no intro offer.
    func testStoreKitConfigurationMatchesAppStoreConnect() throws {
        let data = try Data(contentsOf: Self.storeKitFile)
        let text = String(decoding: data, as: UTF8.self)
        XCTAssertFalse(text.contains("FinalCut"), "storekit config still says FinalCut")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let groups = try XCTUnwrap(json["subscriptionGroups"] as? [[String: Any]])
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0]["name"] as? String, "FinalCap Pro")
        let subs = try XCTUnwrap(groups[0]["subscriptions"] as? [[String: Any]])
        XCTAssertEqual(subs.count, 1)
        let sub = subs[0]
        XCTAssertEqual(sub["productID"] as? String, StoreKitPurchaseStub.monthlyProductID)
        XCTAssertEqual(sub["referenceName"] as? String, "FinalCap Pro Monthly")
        XCTAssertEqual(sub["displayPrice"] as? String, "9.99")
        XCTAssertEqual(sub["recurringSubscriptionPeriod"] as? String, "P1M")
        XCTAssertEqual(sub["groupNumber"] as? Int, 1)
        XCTAssertEqual(sub["familyShareable"] as? Bool, false)
        XCTAssertTrue(sub["introductoryOffer"] is NSNull, "no free trial is promised in the app copy")
        let loc = try XCTUnwrap((sub["localizations"] as? [[String: Any]])?.first)
        XCTAssertEqual(loc["displayName"] as? String, "FinalCap Pro Monthly")
    }

    /// Empty product list (offline / not configured): retries automatically, then shows the unavailable state
    /// (message + Try Again), never a dead Subscribe button; Try Again fetches again.
    @MainActor
    func testEmptyProductsEndInUnavailableStateAndRetryRefetches() async {
        let counter = Counter()
        let store = PaywallStore(loader: { await counter.bump(); return [] }, retryDelaysNanos: [0, 0])
        XCTAssertEqual(store.state, .idle)
        await store.load()
        XCTAssertEqual(store.state, .unavailable)
        XCTAssertNil(store.product)
        XCTAssertEqual(store.loadAttempts, 3)
        let fetched = await counter.value
        XCTAssertEqual(fetched, 3)
        await store.retry()
        XCTAssertEqual(store.state, .unavailable)
        XCTAssertEqual(store.loadAttempts, 6)
    }

    /// Real StoreKit load through SKTestSession: localized price and period come from StoreKit.
    @MainActor
    func testProductLoadsFromStoreKitConfiguration() async throws {
        let session = try SKTestSession(contentsOf: Self.storeKitFile)
        session.disableDialogs = true
        session.clearTransactions()
        let store = PaywallStore(retryDelaysNanos: [1_000_000_000, 1_000_000_000, 2_000_000_000, 2_000_000_000])
        await store.load()
        let product = try XCTUnwrap(store.product, "product not loaded from FinalCut.storekit")
        XCTAssertEqual(product.id, StoreKitPurchaseStub.monthlyProductID)
        XCTAssertEqual(product.displayName, "FinalCap Pro Monthly")
        XCTAssertEqual(product.displayPrice, "$9.99")
        let period = try XCTUnwrap(product.subscription?.subscriptionPeriod)
        XCTAssertEqual(period.unit, .month)
        XCTAssertEqual(period.value, 1)
        XCTAssertNil(product.subscription?.introductoryOffer)
        XCTAssertEqual(PaywallCopy.priceLine(displayPrice: product.displayPrice, value: period.value, unit: period.unit),
                       "$9.99 / month")
        withExtendedLifetime(session) {}
    }
}

private actor Counter {
    private(set) var value = 0
    func bump() { value += 1 }
}
