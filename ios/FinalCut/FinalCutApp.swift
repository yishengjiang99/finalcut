import SwiftUI

@main
struct FinalCutApp: App {
    @StateObject private var appModel = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(appModel)
                .preferredColorScheme(.dark)
                .task { await appModel.bootstrap() }
        }
    }
}

/// Shared session state. The app launches straight into the Editor; there is no
/// Landing / SignIn / Paywall gate. The paywall is a sheet presented from the Editor
/// (Upgrade button, or when the server reports the free usage limit was hit).
@MainActor
final class AppModel: ObservableObject {
    /// Why the paywall sheet is showing (drives the headline copy).
    enum PaywallReason: Equatable {
        case upgradeTapped
        case usageLimitReached
    }

    @Published var isAuthenticated = false
    @Published var hasSubscription = false
    /// Free daily inference quota (from `GET /api/auth/status` for device installs). Nil when unknown/premium.
    @Published var dailyLimit: Int?
    @Published var dailyRemaining: Int?
    @Published var isPaywallPresented = false
    @Published var paywallReason: PaywallReason = .upgradeTapped

    let apiClient = APIClient()

    private var didBootstrap = false

    /// Runs silently in the background on launch — never blocks or gates the Editor.
    func bootstrap() async {
        guard !didBootstrap else { return }
        didBootstrap = true

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
    }

    /// Refreshes subscription + free-quota state from `GET /api/auth/status`.
    func refreshQuota() async {
        guard let status = try? await apiClient.fetchAuthStatus() else { return }
        apply(status)
    }

    func apply(_ status: AuthStatus) {
        isAuthenticated = status.authenticated
        hasSubscription = status.user?.hasSubscription == true
        if hasSubscription {
            dailyLimit = nil
            dailyRemaining = nil
        } else {
            dailyLimit = status.dailyLimit
            dailyRemaining = status.dailyRemaining
        }
    }

    func presentPaywall(reason: PaywallReason = .upgradeTapped) {
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
