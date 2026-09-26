import Foundation

/// User settings for on-device editing.
enum NativeSettings {
    /// Settings → Cloud processing. Default **off**: nothing is ever uploaded.
    static let cloudProcessingKey = "settings.cloudProcessing"
    /// Set once the first-export "Notify me when it's done" offer has been shown.
    static let notifyOfferShownKey = "export.notifyOfferShown"
}
