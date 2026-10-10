import SwiftUI
import StoreKit
import StoreKitTest
import UIKit
import XCTest
@testable import FinalCut

/// Captures the real FinalCap Pro paywall for the App Store subscription review screenshot.
/// Opt-in only (ios-screenshots workflow): TEST_RUNNER_FC_PAYWALL_SHOT=1 and
/// TEST_RUNNER_FC_PAYWALL_OUT=<host dir>. Loads the product from FinalCut.storekit through SKTestSession
/// (this hosted test runs in the app process), presents PaywallView full screen, writes <out>/paywall-ready,
/// then holds the screen so the workflow can `simctl io screenshot` it.
final class PaywallScreenshotTests: XCTestCase {
    @MainActor
    func testCapturePaywallForReview() async throws {
        let env = ProcessInfo.processInfo.environment
        guard env["FC_PAYWALL_SHOT"] == "1", let outPath = env["FC_PAYWALL_OUT"] else {
            throw XCTSkip("opt-in: TEST_RUNNER_FC_PAYWALL_SHOT=1 TEST_RUNNER_FC_PAYWALL_OUT=<dir>")
        }
        let out = URL(fileURLWithPath: outPath, isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

        let ios = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let session = try SKTestSession(contentsOf: ios.appendingPathComponent("FinalCut/StoreKit/FinalCut.storekit"))
        session.disableDialogs = true
        session.clearTransactions()

        let store = PaywallStore(retryDelaysNanos: [1_000_000_000, 2_000_000_000, 2_000_000_000, 3_000_000_000])
        await store.load()
        let product = try XCTUnwrap(store.product, "product not loaded")
        print("[paywall-shot] \(product.displayName) \(product.displayPrice)")
        XCTAssertEqual(product.displayPrice, "$9.99")

        let appModel = AppModel()
        appModel.paywallReason = .upgradeTapped
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = try XCTUnwrap(scene.windows.first(where: \.isKeyWindow) ?? scene.windows.first)
        var top = try XCTUnwrap(window.rootViewController)
        while let presented = top.presentedViewController { top = presented }
        let host = UIHostingController(rootView: PaywallView(store: store)
            .environmentObject(appModel)
            .preferredColorScheme(.dark))
        host.modalPresentationStyle = .fullScreen
        top.present(host, animated: false)
        try await Task.sleep(nanoseconds: 4_000_000_000)

        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        try XCTUnwrap(image.pngData()).write(to: out.appendingPathComponent("paywall-render.png"))
        try Data("ready".utf8).write(to: out.appendingPathComponent("paywall-ready"))
        for _ in 0..<60 where !FileManager.default.fileExists(atPath: out.appendingPathComponent("paywall-done").path) {
            try await Task.sleep(nanoseconds: 1_000_000_000)
        }
        host.dismiss(animated: false)
        withExtendedLifetime(session) {}
    }
}
