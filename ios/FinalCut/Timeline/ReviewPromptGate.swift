import Foundation

/// Pure gating logic for the post-export App Store review prompt (FinalCap 1.2, Lever 1).
/// Foundation-only on purpose: eligibility is a pure function of persisted state, so the
/// trimmed smoke suite can cover it with no StoreKit or UI involvement. The prompt is
/// requested only after a successful export — never at launch, never mid-edit, and
/// never after a failed or cancelled export.
enum ReviewPromptGate {
    /// Minimum successful exports (ever) before a prompt may be requested: the first
    /// export is the aha, the second proves repeat value.
    static let exportThreshold = 2
    /// Minimum days between two prompt requests (Apple separately caps prompts at
    /// 3 per 365 days per user regardless of what the app asks for).
    static let cooldownDays = 90

    static var cooldown: TimeInterval { TimeInterval(cooldownDays) * 24 * 60 * 60 }

    /// - Parameters:
    ///   - successfulExportCount: lifetime count AFTER the just-completed export.
    ///   - lastPromptDate: when a prompt was last requested, if ever.
    ///   - sessionBlocked: a paywall was dismissed or a purchase cancelled this session.
    static func isEligible(successfulExportCount: Int, lastPromptDate: Date?,
                           sessionBlocked: Bool, now: Date) -> Bool {
        guard successfulExportCount >= exportThreshold else { return false }
        guard !sessionBlocked else { return false }
        if let lastPromptDate, now.timeIntervalSince(lastPromptDate) < cooldown { return false }
        return true
    }
}

/// Persisted state behind `ReviewPromptGate` and the single entry point the export
/// flow calls when an export succeeds. The lifetime count advances ONLY through
/// `recordSuccessfulExport(now:)` — failed and cancelled exports never reach it.
final class ReviewPromptTracker {
    static let shared = ReviewPromptTracker()

    private enum Key {
        static let exportCount = "reviewPrompt.successfulExportCount"
        static let lastPromptDate = "reviewPrompt.lastPromptDate"
        static let firstExportDate = "reviewPrompt.firstExportDate"
    }

    private let defaults: UserDefaults
    /// Paywall dismissed or purchase cancelled during this app session. In-memory
    /// only, so it clears on the next launch.
    private(set) var sessionBlocked = false

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var successfulExportCount: Int { defaults.integer(forKey: Key.exportCount) }

    var lastPromptDate: Date? {
        let t = defaults.double(forKey: Key.lastPromptDate)
        return t > 0 ? Date(timeIntervalSince1970: t) : nil
    }

    var firstExportDate: Date? {
        let t = defaults.double(forKey: Key.firstExportDate)
        return t > 0 ? Date(timeIntervalSince1970: t) : nil
    }

    /// Called when a paywall is dismissed or a purchase is cancelled: no prompt
    /// may be requested for the rest of this session.
    func blockSession() { sessionBlocked = true }

    /// Records a successful export (the count increments here and nowhere else)
    /// and answers whether the review prompt may be requested now.
    func recordSuccessfulExport(now: Date = Date()) -> Bool {
        let count = successfulExportCount + 1
        defaults.set(count, forKey: Key.exportCount)
        if firstExportDate == nil {
            defaults.set(now.timeIntervalSince1970, forKey: Key.firstExportDate)
        }
        return ReviewPromptGate.isEligible(successfulExportCount: count,
                                           lastPromptDate: lastPromptDate,
                                           sessionBlocked: sessionBlocked,
                                           now: now)
    }

    /// Stamps the cooldown. Call in the same moment the prompt is requested.
    func markPromptRequested(now: Date = Date()) {
        defaults.set(now.timeIntervalSince1970, forKey: Key.lastPromptDate)
    }

    /// Props for the `review_prompt_requested` telemetry event. The event means
    /// "requested" — the OS decides whether the prompt actually displays and
    /// does not report that back.
    func telemetryProps(now: Date = Date()) -> [String: Any] {
        var props: [String: Any] = ["export_count": successfulExportCount]
        if let firstExportDate {
            props["days_since_first_export"] = Int(now.timeIntervalSince(firstExportDate) / 86_400)
        }
        return props
    }
}
