import SwiftUI

/// Root: the Editor (chat + import panel) is the first and only screen.
/// Paywall is presented as a sheet from the Editor.
struct ContentView: View {
    var body: some View {
        EditorView()
            .background(AppTheme.background.ignoresSafeArea())
    }
}

#Preview {
    ContentView()
        .environmentObject(AppModel())
}
