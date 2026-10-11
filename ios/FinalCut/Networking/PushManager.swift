import Foundation
import UIKit
import UserNotifications

/// Remote (APNs) notifications for the lifecycle tips in docs/push-lifecycle.md.
///
/// * Permission is only ever asked by the existing "Notify me when it's done" soft prompt on the
///   first video export (a moment of value). Never on launch.
/// * After permission: the device token, time zone and app version go to POST /api/push/register.
/// * While notifications are allowed, a few event names (app_open, export_done, paywall_view,
///   push_opened) are reported so tips fit what the user did. No prompts, media or captions.
/// * "Tips & offers" (promotional pushes, App Store Guideline 4.5.4) is a separate opt-in in
///   Settings and is off by default.
@MainActor
final class PushManager: NSObject, ObservableObject {
    static let shared = PushManager()

    enum Destination: String, Equatable {
        case editor
        case paywall
    }

    static let marketingOptInKey = "push.marketingOptIn"
    private static let lastTokenKey = "push.lastRegisteredToken"
    private static let lastOpenEventKey = "push.lastAppOpenEvent"

    @Published private(set) var authorization: UNAuthorizationStatus = .notDetermined
    @Published private(set) var marketingOptIn: Bool

    private var api: APIClient?
    private var openPaywall: (() -> Void)?
    private var pendingDestination: Destination?
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.marketingOptIn = defaults.bool(forKey: Self.marketingOptInKey)
        super.init()
    }

    /// Called once from AppModel.bootstrap after the device session exists.
    func configure(api: APIClient, openPaywall: @escaping () -> Void) {
        self.api = api
        self.openPaywall = openPaywall
        if let pending = pendingDestination {
            pendingDestination = nil
            route(pending)
        }
        Task { await refreshAuthorizationAndRegister(reportOpen: true) }
    }

    /// Installs the delegate early (didFinishLaunching) so a tap that launched the app is seen.
    func installDelegate() {
        UNUserNotificationCenter.current().delegate = self
    }

    /// Re-check on launch and after the soft prompt: if allowed, (re)register with APNs.
    func refreshAuthorizationAndRegister(reportOpen: Bool = false) async {
        guard api != nil else { return }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        authorization = settings.authorizationStatus
        guard Self.isAllowed(settings.authorizationStatus) else {
            // Turned off in iOS Settings: stop server-side tips for this device.
            if defaults.string(forKey: Self.lastTokenKey) != nil {
                defaults.removeObject(forKey: Self.lastTokenKey)
                try? await api?.pushRequest(path: APIEndpoints.pushRegister, method: "DELETE", json: [:])
            }
            return
        }
        UIApplication.shared.registerForRemoteNotifications()
        if reportOpen { reportAppOpenIfDue() }
    }

    /// The soft prompt's permission request finished.
    func permissionResult(granted: Bool) {
        Task { await refreshAuthorizationAndRegister(reportOpen: granted) }
    }

    func didRegister(deviceToken: Data) {
        let hex = Self.hex(deviceToken)
        Task {
            var body: [String: Any] = [
                "token": hex,
                "environment": Self.apnsEnvironment,
                "tz": TimeZone.current.identifier,
                "appVersion": Self.appVersion,
            ]
            body["marketingOptIn"] = marketingOptIn
            do {
                try await api?.pushRequest(path: APIEndpoints.pushRegister, method: "POST", json: body)
                defaults.set(hex, forKey: Self.lastTokenKey)
            } catch {
                // Retried on the next launch.
            }
        }
    }

    func setMarketingOptIn(_ on: Bool) {
        marketingOptIn = on
        defaults.set(on, forKey: Self.marketingOptInKey)
        Task { try? await api?.pushRequest(path: APIEndpoints.pushPrefs, method: "PUT", json: ["marketingOptIn": on]) }
    }

    /// Reports an allowlisted event, only while notifications are allowed.
    func track(_ event: String, sendId: String? = nil) {
        guard Self.allowedEvents.contains(event), Self.isAllowed(authorization), let api else { return }
        var body: [String: Any] = ["event": event]
        if let sendId { body["sendId"] = sendId }
        Task { try? await api.pushRequest(path: APIEndpoints.pushEvents, method: "POST", json: body) }
    }

    /// At most one app_open per hour (enough for "last seen" without chatter).
    private func reportAppOpenIfDue(now: Date = Date()) {
        let last = defaults.double(forKey: Self.lastOpenEventKey)
        guard now.timeIntervalSince1970 - last > 3600 else { return }
        defaults.set(now.timeIntervalSince1970, forKey: Self.lastOpenEventKey)
        track("app_open")
    }

    func handleTap(userInfo: [String: String]) {
        let (destination, sendId) = Self.parse(userInfo)
        if let sendId { track("push_opened", sendId: sendId) }
        if openPaywall == nil {
            pendingDestination = destination
        } else {
            route(destination)
        }
    }

    private func route(_ destination: Destination) {
        switch destination {
        case .editor: break // the app always opens in the Editor
        case .paywall: openPaywall?()
        }
    }

    // MARK: - Pure helpers (unit tested)

    nonisolated static let allowedEvents: Set<String> = ["app_open", "export_done", "paywall_view", "push_opened"]

    nonisolated static func isAllowed(_ status: UNAuthorizationStatus) -> Bool {
        status == .authorized || status == .provisional || status == .ephemeral
    }

    /// Lifecycle payload → where to go + send id. Anything unexpected opens the Editor.
    nonisolated static func parse(_ userInfo: [String: String]) -> (Destination, String?) {
        let destination = userInfo["destination"].flatMap(Destination.init(rawValue:)) ?? .editor
        let sendId = userInfo["send_id"].flatMap { id -> String? in
            UUID(uuidString: id) != nil ? id.lowercased() : nil
        }
        return (destination, sendId)
    }

    nonisolated static func hex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }

    /// Debug builds are signed with aps-environment=development; TestFlight/App Store use production.
    nonisolated static var apnsEnvironment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    nonisolated static var appVersion: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let v = info["CFBundleShortVersionString"] as? String ?? "0"
        let b = info["CFBundleVersion"] as? String ?? "0"
        return "\(v) (\(b))"
    }
}

extension PushManager: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        var info: [String: String] = [:]
        for (k, v) in response.notification.request.content.userInfo {
            if let k = k as? String, let v = v as? String { info[k] = v }
        }
        let isLifecycle = info["type"] == "lifecycle"
        Task { @MainActor in
            if isLifecycle { PushManager.shared.handleTap(userInfo: info) }
            completionHandler()
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // Don't interrupt someone who is already editing with a tip.
        let isLifecycle = (notification.request.content.userInfo["type"] as? String) == "lifecycle"
        completionHandler(isLifecycle ? [] : [.banner, .sound])
    }
}

/// Receives the APNs device token callbacks (SwiftUI has no other hook for them).
@MainActor
final class FinalCutAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        PushManager.shared.installDelegate()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushManager.shared.didRegister(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Simulator / missing entitlement: nothing to do; local export notifications still work.
    }
}
