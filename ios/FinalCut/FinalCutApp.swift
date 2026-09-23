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

/// Shared app navigation + session state.
@MainActor
final class AppModel: ObservableObject {
    enum Route: Hashable {
        case landing
        case signIn
        case paywall
        case editor
    }

    // Open directly into the usable editor; the bundled demo video is loaded there.
    @Published var route: Route = .editor
    @Published var isAuthenticated = false
    @Published var isSampleMode = false
    @Published var hasUnlockedEditor = false
    @Published var isTestVideoMode = false

    let apiClient = APIClient()

    private var didBootstrap = false

    func bootstrap() async {
        guard !didBootstrap else { return }
        didBootstrap = true
        do {
            _ = try await apiClient.ensureDeviceSession()
            let status = try await apiClient.fetchAuthStatus()
            isAuthenticated = status.authenticated
            if status.user?.hasSubscription == true || (status.dailyRemaining ?? 0) > 0 {
                hasUnlockedEditor = true
                route = .editor
            } else if status.authenticated {
                route = .paywall
            }
        } catch {
            // Keep the landing/paywall flow usable while offline; inference still requires the server token.
        }
    }

    func goToSignIn() {
        clearTestVideoMode()
        route = .signIn
    }

    func completeSignIn(sampleMode: Bool = false) {
        isAuthenticated = !sampleMode
        isSampleMode = sampleMode
        apiClient.sampleModeEnabled = sampleMode
        route = .paywall
    }

    func unlockEditor() {
        clearTestVideoMode()
        hasUnlockedEditor = true
        route = .editor
    }

    func skipToEditorForDev() {
        clearTestVideoMode()
        hasUnlockedEditor = true
        route = .editor
    }

    func tryTestVideoNow() {
        isSampleMode = true
        isTestVideoMode = true
        apiClient.sampleModeEnabled = true
        hasUnlockedEditor = true
        route = .editor
    }

    private func clearTestVideoMode() {
        isSampleMode = false
        isTestVideoMode = false
        apiClient.sampleModeEnabled = false
    }
}
