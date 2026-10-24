import SwiftUI

@main
struct FinalCutApp: App {
    @UIApplicationDelegateAdaptor(FinalCutAppDelegate.self) private var appDelegate
    @StateObject private var appModel = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(appModel)
                .preferredColorScheme(.dark)
                .task { await appModel.bootstrap() }
        }
        .onChange(of: scenePhase) { _, phase in
            // Picks up a change made in iOS Settings → Notifications while the app was away.
            if phase == .active {
                Task { await PushManager.shared.refreshAuthorizationAndRegister(reportOpen: true) }
            }
        }
    }
}

/// Shared session state. The app launches straight into the Editor; there is no
/// Landing / SignIn / Paywall gate. The paywall is a dismissible sheet presented
/// from the Editor (Upgrade button, once per cold launch for non-subscribers,
/// or when the server reports the free usage limit was hit).
@MainActor
final class AppModel: ObservableObject {
    /// Why the paywall sheet is showing (drives the headline copy).
    enum PaywallReason: Equatable {
        case upgradeTapped
        case usageLimitReached
        case atLaunch
    }

    @Published var isAuthenticated = false
    @Published var hasSubscription = false
    /// Free daily inference quota (from `GET /api/auth/status` for device installs). Nil when unknown/premium.
    @Published var dailyLimit: Int?
    @Published var dailyRemaining: Int?
    /// Server says edits are unlimited for now: hide the free count, never auto-open the paywall.
    @Published var isUnlimited = false
    @Published var isPaywallPresented = false
    @Published var paywallReason: PaywallReason = .upgradeTapped

    let apiClient = APIClient()

    private var didBootstrap = false

    /// UserDefaults key recording the last launch-paywall presentation (v1.1).
    private static let lastLaunchPaywallShownKey = "paywall.lastLaunchShownAt"

    /// Runs in the background on launch — never blocks or gates the Editor
    /// (the launch paywall below is a dismissible sheet, not a gate).
    func bootstrap() async {
        guard !didBootstrap else { return }
        didBootstrap = true

        // Push: token upload only if notifications are already allowed (never asks here).
        PushManager.shared.configure(api: apiClient) { [weak self] in
            self?.presentPaywall(reason: .upgradeTapped)
        }

        #if DEBUG
        // DEBUG / demo: warm the sample token (`sample-access-token` header) in the background.
        let client = apiClient
        Task { _ = try? await client.ensureSampleAccessToken() }
        #endif

        do {
            try await apiClient.ensureDeviceSession()
        } catch {
            // Offline or server unavailable: the Editor stays usable; requests will retry auth.
            return
        }
        await refreshQuota()
        presentLaunchPaywallIfNeeded()
    }

    /// v1.1: present the paywall once per cold launch to non-subscribers.
    /// Runs at the end of `bootstrap()`, after the first `/api/auth/status`
    /// refresh, so subscription state is known and subscribers never see it.
    /// Skipped when auth state is unknown (offline / status fetch failed)
    /// rather than guessing. The presentation timestamp is recorded for
    /// observability; the cadence is every cold launch, so it does not gate.
    private func presentLaunchPaywallIfNeeded() {
        guard isAuthenticated, !hasSubscription, !isPaywallPresented else { return }
        UserDefaults.standard.set(Date(), forKey: Self.lastLaunchPaywallShownKey)
        presentPaywall(reason: .atLaunch)
    }

    /// Refreshes subscription + free-quota state from `GET /api/auth/status`.
    func refreshQuota() async {
        guard let status = try? await apiClient.fetchAuthStatus() else { return }
        apply(status)
    }

    func apply(_ status: AuthStatus) {
        isAuthenticated = status.authenticated
        hasSubscription = status.user?.hasSubscription == true
        isUnlimited = status.isUnlimited
        if hasSubscription || isUnlimited {
            dailyLimit = nil
            dailyRemaining = nil
        } else {
            dailyLimit = status.dailyLimit
            dailyRemaining = status.dailyRemaining
        }
    }

    func presentPaywall(reason: PaywallReason = .upgradeTapped) {
        // While edits are unlimited, only the Upgrade button opens the paywall.
        if reason == .usageLimitReached, isUnlimited { return }
        paywallReason = reason
        if reason == .usageLimitReached, !hasSubscription {
            dailyRemaining = 0
        }
        isPaywallPresented = true
    }

    /// Called after StoreKit purchase/restore is verified by the server.
    func subscriptionActivated(_ status: AuthStatus? = nil) {
        if let status {
            apply(status)
        }
        hasSubscription = true
        dailyLimit = nil
        dailyRemaining = nil
        isPaywallPresented = false
    }
}
