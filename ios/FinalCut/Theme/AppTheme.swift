import SwiftUI

enum AppTheme {
    static let background = Color(red: 0.07, green: 0.07, blue: 0.09)
    static let surface = Color(red: 0.12, green: 0.12, blue: 0.14)
    static let surfaceElevated = Color(red: 0.16, green: 0.16, blue: 0.19)
    static let border = Color.white.opacity(0.08)
    static let textPrimary = Color.white
    static let textSecondary = Color.white.opacity(0.65)
    static let accent = Color(red: 0.35, green: 0.78, blue: 0.98)
    static let danger = Color(red: 0.95, green: 0.35, blue: 0.35)
    static let success = Color(red: 0.35, green: 0.85, blue: 0.55)

    static let cornerRadius: CGFloat = 12
    static let chipRadius: CGFloat = 16
}

/// Feature switches.
/// The multi-clip timeline surface is sidelined (2026-10-27, at the user's
/// word) on both clients: the editor never renders the timeline view, so
/// timeline mode can't be entered from the UI. All timeline code, projects,
/// and the library stay in place — flip this back to re-enable.
enum FeatureFlags {
    static let timelineEnabled = false
}
