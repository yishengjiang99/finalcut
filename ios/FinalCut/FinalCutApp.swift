import SwiftUI

@main
struct FinalCutApp: App {
    @StateObject private var appModel = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(appModel)
                .preferredColorScheme(.dark)
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

    @Published var route: Route = .landing
    @Published var isAuthenticated = false
    @Published var isSampleMode = false
    @Published var hasUnlockedEditor = false
    @Published var isTestVideoMode = false

    let apiClient = APIClient()

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
