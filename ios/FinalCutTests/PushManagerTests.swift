import XCTest
import UserNotifications
@testable import FinalCut

/// Lifecycle push helpers (docs/push-lifecycle.md): payload parsing, token hex, consent defaults.
@MainActor
final class PushManagerTests: XCTestCase {
    func testParseKnownDestinationsAndSendId() {
        let id = "3F2504E0-4F89-11D3-9A0C-0305E82C3301"
        let (d, sid) = PushManager.parse(["type": "lifecycle", "destination": "paywall", "send_id": id])
        XCTAssertEqual(d, .paywall)
        XCTAssertEqual(sid, id.lowercased())
        XCTAssertEqual(PushManager.parse(["destination": "editor"]).0, .editor)
    }

    func testUnknownPayloadsOpenTheEditorAndDropBadIds() {
        let (d, sid) = PushManager.parse(["destination": "https://evil.example", "send_id": "not-a-uuid"])
        XCTAssertEqual(d, .editor)
        XCTAssertNil(sid)
        XCTAssertEqual(PushManager.parse([:]).0, .editor)
    }

    func testNotifyOfferOnlyWhileNeverAskedAndNotSnoozed() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertTrue(PushManager.shouldOfferNotifications(status: .notDetermined, dismissedAt: nil, now: now))
        XCTAssertFalse(PushManager.shouldOfferNotifications(status: .authorized, dismissedAt: nil, now: now))
        XCTAssertFalse(PushManager.shouldOfferNotifications(status: .denied, dismissedAt: nil, now: now))
        XCTAssertFalse(PushManager.shouldOfferNotifications(status: .provisional, dismissedAt: nil, now: now))
        XCTAssertFalse(PushManager.shouldOfferNotifications(
            status: .notDetermined, dismissedAt: now.addingTimeInterval(-3600), now: now))
        XCTAssertTrue(PushManager.shouldOfferNotifications(
            status: .notDetermined, dismissedAt: now.addingTimeInterval(-8 * 24 * 3600), now: now))
    }

    func testOldOneTimeOfferFlagNoLongerBlocksTheOffer() {
        // Builds before 1.0.1 (17) set export.notifyOfferShown on the first edited video export,
        // which hid the offer forever. Only the iOS status and the "Not now" snooze matter now.
        let defaults = UserDefaults(suiteName: "PushManagerTests.offer")!
        defaults.removePersistentDomain(forName: "PushManagerTests.offer")
        defaults.set(true, forKey: NativeSettings.notifyOfferShownKey)
        XCTAssertNil(defaults.object(forKey: PushManager.notifyOfferDismissedAtKey))
        XCTAssertTrue(PushManager.shouldOfferNotifications(
            status: .notDetermined, dismissedAt: defaults.object(forKey: PushManager.notifyOfferDismissedAtKey) as? Date))
    }

    func testTokenHex() {
        XCTAssertEqual(PushManager.hex(Data([0x00, 0xab, 0x10, 0xff])), "00ab10ff")
    }

    func testOnlyAllowlistedEventsAndAllowedStatuses() {
        XCTAssertEqual(PushManager.allowedEvents, ["app_open", "export_done", "paywall_view", "push_opened"])
        XCTAssertTrue(PushManager.isAllowed(.authorized))
        XCTAssertTrue(PushManager.isAllowed(.provisional))
        XCTAssertFalse(PushManager.isAllowed(.denied))
        XCTAssertFalse(PushManager.isAllowed(.notDetermined))
    }

    func testTipsAndOffersIsOffByDefaultAndPersists() {
        let suite = "PushManagerTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let manager = PushManager(defaults: defaults)
        XCTAssertFalse(manager.marketingOptIn)
        manager.setMarketingOptIn(true)
        XCTAssertTrue(PushManager(defaults: defaults).marketingOptIn)
    }

    func testDebugBuildsUseSandbox() {
        #if DEBUG
        XCTAssertEqual(PushManager.apnsEnvironment, "sandbox")
        #else
        XCTAssertEqual(PushManager.apnsEnvironment, "production")
        #endif
    }
}
