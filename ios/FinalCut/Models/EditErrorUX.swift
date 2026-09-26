import Foundation

/// User-facing copy from docs/ios/NATIVE_EDIT_UX.md §6 (#87, #90). Server `error` text is
/// never shown; UI is chosen from the stable `code` only.
enum UXCopy {
    static let photoUnsupported = "That works on videos, not photos."          // edit.failed.photoUnsupported
    static let invalidArgs = "Couldn't apply that edit. Try saying it another way." // edit.failed.invalidArgs
    static let generic = "Something went wrong with that edit."                // edit.failed.generic
    static let importFailedFormat = "Couldn't open this photo. Try a different one." // import.failed.format
    static let chooseAnother = "Choose another"                                // import.chooseAnother
    static let exportPhotoTitle = "Save photo"                                 // export.photo.title
    static let retry = "Retry"
    static let savedToPhotos = "Saved to Photos"
    static let saveFailed = "Couldn't save to Photos. Check Photos access in Settings."
    static let videoImportFailed = "Couldn't load this video from Photos. Try another video."
    static let unavailable = "Not available on iPhone yet"                    // edit.unavailable
    static let onDevice = "On device"                                          // edit.onDevice
    static let cloud = "Cloud"                                                 // edit.cloud
    static let undo = "Undo"                                                   // edit.undo
    static let cloudSettingTitle = "Cloud processing"                         // cloud.setting.title
    static let cloudSettingFootnote = "Lets FinalCap upload a clip to our servers for edits your iPhone can't do yet. Off means nothing is ever uploaded." // cloud.setting.footnote
    static let cloudFlattened = "Earlier edits were baked in by a cloud step." // cloud.flattened
    static let exportRendering = "Rendering on your iPhone…"                  // export.rendering (+ " {pct}%")
    static let exportRenderedLocal = "Rendered on your iPhone."               // export.rendered.local
    static let exportLeaveHint = "You can leave the app. We'll let you know when it's ready." // export.leaveHint
    static let exportNotifyMe = "Notify me when it's done"                    // export.notifyMe
    static let exportResuming = "Resuming export…"                            // export.resuming
    static let notifVideoTitle = "Your video is ready"                        // notif.video.title
    static let notifVideoBodyPhotos = "Saved to Photos. Tap to open FinalCap." // notif.video.body.photos
    static let notifPhotoTitle = "Your photo is ready"                        // notif.photo.title
    static let notifFailedTitle = "Export didn't finish"                      // notif.failed.title
    static let notifFailedBody = "Open FinalCap to try again."                // notif.failed.body
    static let dictationListening = "Listening…"                              // dictation.listening
    static let dictationUnavailable = "Dictation isn't available on this device." // dictation.unavailable
    static let dictationPermissionDenied = "Turn on Microphone and Speech Recognition for FinalCap in Settings." // dictation.permissionDenied
    static let dictationQueued = "Queued"                                      // dictation.queued
    static let paywallSubheadUnlimited = "Editing is free while FinalCap is new. Subscribe to support it and keep unlimited edits when free limits return." // paywall.subhead.unlimitedPeriod
    static let privacyFirstRun = "Your video stays on your iPhone. FinalCap sends your request and a few still frames to the AI so it understands your clip." // privacy.firstRun

    static let captionsOnDevice = "Captions"                                   // captions.done (+ " · On device")
    static let captionsNoSpeech = "No speech found to caption."               // captions.noSpeech
    static let captionsPermission = "Turn on Speech Recognition for FinalCap in Settings to make captions." // captions.permission

    static func exportRendering(percent: Int) -> String { "\(exportRendering) \(percent)%" }
}

/// Stable server error codes (Backend #88), shared by sync error bodies and failed job polls.
enum ServerErrorCode {
    static let unsupportedForPhoto = "unsupported_for_photo"
    static let invalidArguments = "invalid_arguments"
    static let unsupportedImageFormat = "unsupported_image_format"
}

/// How a failed edit is presented (NATIVE_EDIT_UX.md §8).
enum EditFailureKind: String, Codable, Equatable {
    /// 400 `unsupported_for_photo` → failed card, no Retry.
    case photoUnsupported
    /// 400 `invalid_arguments` → returned to the model; card only if the turn ends without success.
    case invalidArguments
    /// 415 `unsupported_image_format` → import-step error with "Choose another" (not an edit card).
    case unsupportedImageFormat
    /// Anything else / no code → failed card with Retry.
    case generic
    /// No native version and Cloud processing is off → muted card, no Retry (§1 `unavailable`).
    case unavailable

    static func from(code: String?) -> EditFailureKind {
        switch code?.lowercased() {
        case ServerErrorCode.unsupportedForPhoto: return .photoUnsupported
        case ServerErrorCode.invalidArguments: return .invalidArguments
        case ServerErrorCode.unsupportedImageFormat: return .unsupportedImageFormat
        default: return .generic
        }
    }

    /// Error string returned to the model in the client-mode tool result.
    var toolError: String {
        switch self {
        case .photoUnsupported: return ServerErrorCode.unsupportedForPhoto
        case .invalidArguments: return ServerErrorCode.invalidArguments
        case .unsupportedImageFormat: return ServerErrorCode.unsupportedImageFormat
        case .generic: return "edit_failed"
        case .unavailable: return "unsupported_on_device"
        }
    }

    var copy: String {
        switch self {
        case .photoUnsupported: return UXCopy.photoUnsupported
        case .invalidArguments: return UXCopy.invalidArgs
        case .unsupportedImageFormat: return UXCopy.importFailedFormat
        case .generic: return UXCopy.generic
        case .unavailable: return UXCopy.unavailable
        }
    }

    var allowsRetry: Bool { self == .generic }
}

/// Failed edit card attached to a chat message.
struct EditFailureCard: Codable, Equatable {
    var kind: EditFailureKind
    /// Composer text to resend when Retry is tapped (only for `.generic`).
    var retryPrompt: String?

    var copy: String { kind.copy }
    var showsRetry: Bool { kind.allowsRetry && retryPrompt != nil }
}

/// Per-turn bookkeeping so cards follow the §8 rules.
struct EditTurnOutcome: Equatable {
    var successes = 0
    var failures: [EditFailureKind] = []

    mutating func record(_ result: ClientToolResult, kind: EditFailureKind?) {
        if result.ok { successes += 1 } else if let kind { failures.append(kind) }
    }

    /// Card to show when the turn ends. `photoUnsupported` cards are shown immediately and
    /// `unsupportedImageFormat` goes to the import step, so neither is repeated here.
    func endOfTurnCard(prompt: String) -> EditFailureCard? {
        if failures.contains(.generic) {
            return EditFailureCard(kind: .generic, retryPrompt: prompt)
        }
        if successes == 0, failures.contains(.invalidArguments) {
            return EditFailureCard(kind: .invalidArguments)
        }
        return nil
    }
}
