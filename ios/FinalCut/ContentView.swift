import SwiftUI

/// Root navigation: Landing → SignIn → Paywall → Editor.
struct ContentView: View {
    @EnvironmentObject private var appModel: AppModel

    var body: some View {
        Group {
            switch appModel.route {
            case .landing:
                LandingView()
            case .signIn:
                SignInView()
            case .paywall:
                PaywallView()
            case .editor:
                EditorView()
            }
        }
        .animation(.easeInOut(duration: 0.25), value: appModel.route)
        .background(AppTheme.background.ignoresSafeArea())
    }
}

#Preview {
    ContentView()
        .environmentObject(AppModel())
}
