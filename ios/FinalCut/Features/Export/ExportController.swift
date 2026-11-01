import Foundation
import StoreKit
import SwiftUI
import UIKit
import UserNotifications

/// One export session. Rendering happens on the iPhone (video: AVAssetExportSession over the
/// composed edit with real % and Cancel; photo: Core Image in the original/requested format)
/// and the result is cached so "Save to Photos", "Save to Files" and Share reuse one file.
/// With no edits the original file is exported as-is. Rendering keeps going briefly in the
/// background and posts a local notification when the app isn't active (if allowed).
@MainActor
final class ExportController: ObservableObject {
    enum Phase: Equatable {
        case idle
        case rendering(Int)
        case saving
        case failed(String)
    }

    enum Destination: String, CaseIterable, Identifiable {
        case photos
        case files
        var id: String { rawValue }
        var title: String {
            switch self {
            case .photos: return UXCopy.saveToPhotos
            case .files: return UXCopy.saveToFiles
            }
        }
        var systemImage: String {
            switch self {
            case .photos: return "photo.on.rectangle"
            case .files: return "folder"
            }
        }
    }

    @Published var phase: Phase = .idle
    @Published private(set) var renderedURL: URL?
    @Published var toast: String?
    @Published var photosPermissionDenied = false
    @Published var showNotifyOffer = false
    /// Set when the Files picker should open with `renderedURL`.
    @Published var filesPickerURL: URL?

    private let exporter = NativeExporter()
    private var task: Task<Void, Never>?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var isRunning: Bool {
        switch phase {
        case .rendering, .saving: return true
        default: return false
        }
    }

    // MARK: - Actions

    func save(to destination: Destination, stack: EditStack?, fallbackURL: URL?) {
        guard !isRunning else { return }
        toast = nil
        photosPermissionDenied = false
        var exportProps: [String: Any] = ["destination": destination.rawValue]
        if let duration = stack?.canvas.duration, duration > 0 {
            exportProps["duration_sec"] = (duration * 10).rounded() / 10
        }
        Telemetry.shared.track("export_start", props: exportProps)
        let isPhoto = Self.isPhoto(stack: stack, fallbackURL: fallbackURL)
        offerNotificationsIfNeeded()
        task = Task { [weak self] in
            guard let self else { return }
            do {
                let url = try await self.render(stack: stack, fallbackURL: fallbackURL)
                switch destination {
                case .photos:
                    self.phase = .saving
                    if isPhoto {
                        try await PhotoLibrarySaver.savePhoto(at: url)
                    } else {
                        try await PhotoLibrarySaver.saveVideo(at: url)
                    }
                    self.phase = .idle
                    self.toast = UXCopy.savedToPhotos
                    self.notifyIfInactive(success: true, isPhoto: isPhoto, savedToPhotos: true)
                    PushManager.shared.track("export_done")
                    Telemetry.shared.track("export_success", props: ["destination": Destination.photos.rawValue])
                    self.considerReviewPrompt()
                case .files:
                    self.phase = .idle
                    self.filesPickerURL = url
                    PushManager.shared.track("export_done")
                    Telemetry.shared.track("export_success", props: ["destination": Destination.files.rawValue])
                    self.considerReviewPrompt()
                }
            } catch NativeExporter.ExportError.cancelled {
                self.phase = .idle
            } catch is CancellationError {
                self.phase = .idle
            } catch PhotoLibrarySaver.SaveError.notAuthorized {
                self.phase = .idle
                self.photosPermissionDenied = true
            } catch let error as ProjectComposerError {
                // Name the actual problem in the sheet (a missing file, an
                // invalid project) instead of the generic failure copy, and
                // report it so the next failure is diagnosable server-side.
                self.phase = .failed(Self.composerFailureCopy(error))
                Telemetry.shared.track("export_fail", props: ["reason": Self.composerFailureReason(error)])
                self.notifyIfInactive(success: false, isPhoto: isPhoto, savedToPhotos: false)
            } catch NativeExporter.ExportError.failedWithReason(let reason) {
                self.phase = .failed(UXCopy.notifFailedTitle)
                Telemetry.shared.track("export_fail", props: ["reason": "export_session", "detail": reason])
                self.notifyIfInactive(success: false, isPhoto: isPhoto, savedToPhotos: false)
            } catch {
                self.phase = .failed(UXCopy.notifFailedTitle)
                Telemetry.shared.track("export_fail", props: ["reason": "other", "detail": "\(error)"])
                self.notifyIfInactive(success: false, isPhoto: isPhoto, savedToPhotos: false)
            }
            self.endBackground()
        }
    }

    func cancel() {
        exporter.cancel()
        task?.cancel()
    }

    // MARK: - Review prompt (FinalCap 1.2, Lever 1)

    /// Called only from the two export-success points above; failure and cancel
    /// paths never reach it. Records the success (the lifetime count advances
    /// here and nowhere else), then — when the gate allows — waits for the
    /// success UI to settle and requests the system review prompt on the active
    /// foreground scene. The OS decides whether the prompt actually displays.
    private func considerReviewPrompt() {
        let tracker = ReviewPromptTracker.shared
        guard tracker.recordSuccessfulExport() else { return }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1))
            guard UIApplication.shared.applicationState == .active,
                  let scene = UIApplication.shared.connectedScenes
                    .compactMap({ $0 as? UIWindowScene })
                    .first(where: { $0.activationState == .foregroundActive })
            else { return }
            tracker.markPromptRequested()
            Telemetry.shared.track("review_prompt_requested", props: tracker.telemetryProps())
            SKStoreReviewController.requestReview(in: scene)
        }
    }

    /// Renders once per session (cached). No edits → the original file.
    /// A timeline project ALWAYS renders through the project composer, even with zero
    /// stack entries: the old "no edits → return the base file" shortcut would silently
    /// drop every clip after the first and every independent audio track.
    func render(stack: EditStack?, fallbackURL: URL?) async throws -> URL {
        if let renderedURL { return renderedURL }
        let isPhoto = Self.isPhoto(stack: stack, fallbackURL: fallbackURL)
        guard let base = stack?.base ?? fallbackURL else { throw NativeExporter.ExportError.failed }
        let url: URL
        if let stack, stack.isTimelineProject, let project = stack.project {
            beginBackground()
            phase = .rendering(0)
            let composed = try await NativeComposer.compose(project: project)
            url = try await exporter.export(composed, format: stack.outputFormat) { [weak self] value in
                guard let self, case .rendering = self.phase else { return }
                self.phase = .rendering(min(99, max(0, Int((value * 100).rounded(.down)))))
            }
            try Task.checkCancellation()
        } else if let stack, !stack.entries.isEmpty {
            beginBackground()
            if isPhoto {
                phase = .saving
                url = try await Task.detached(priority: .userInitiated) { try PhotoRenderer.exportFile(stack) }.value
            } else {
                phase = .rendering(0)
                let composed = try await NativeComposer.compose(stack)
                url = try await exporter.export(composed, format: stack.outputFormat) { [weak self] value in
                    guard let self, case .rendering = self.phase else { return }
                    self.phase = .rendering(min(99, max(0, Int((value * 100).rounded(.down)))))
                }
            }
            try Task.checkCancellation()
        } else {
            url = base
        }
        renderedURL = url
        return url
    }

    static func isPhoto(stack: EditStack?, fallbackURL: URL?) -> Bool {
        stack?.isPhoto ?? fallbackURL.map { MediaMIME.isImage(url: $0) } ?? false
    }

    /// User-facing copy for a project-composition failure during export.
    static func composerFailureCopy(_ error: ProjectComposerError) -> String {
        switch error {
        case .missingAsset(_):
            return "A media file in this project is missing."
        case .invalidProject(let issues):
            return "This project couldn't be exported (\(issues.first ?? "invalid project"))."
        case .noVideoTrack(_):
            return "One of the clips in this project has no video track."
        case .noAudioTrack(_):
            return "One of the clips in this project has no audio track."
        }
    }

    /// Telemetry reason string for a project-composition failure during export.
    static func composerFailureReason(_ error: ProjectComposerError) -> String {
        switch error {
        case .missingAsset(_):
            return "missing_asset"
        case .invalidProject(let issues):
            return "invalid_project: " + issues.joined(separator: ",")
        case .noVideoTrack(_):
            return "no_video_track"
        case .noAudioTrack(_):
            return "no_audio_track"
        }
    }

    // MARK: - Notifications (Design §6)

    /// Every export (photo or video, edited or not) offers "Notify me when it's done" while iOS
    /// has never asked for notification permission. It stays visible after the export finishes
    /// until tapped or dismissed with "Not now" (snoozed 7 days). The iOS alert only follows a tap.
    private func offerNotificationsIfNeeded() {
        guard !showNotifyOffer else { return }
        Task { [weak self] in
            let offer = await PushManager.shared.shouldOfferNotifications()
            guard let self, offer else { return }
            self.showNotifyOffer = true
        }
    }

    func requestNotifications() {
        showNotifyOffer = false
        PushManager.shared.requestPermission()
    }

    func dismissNotifyOffer() {
        showNotifyOffer = false
        PushManager.shared.snoozeNotifyOffer()
    }

    private func notifyIfInactive(success: Bool, isPhoto: Bool, savedToPhotos: Bool) {
        guard UIApplication.shared.applicationState != .active else { return }
        let content = UNMutableNotificationContent()
        if success {
            content.title = isPhoto ? UXCopy.notifPhotoTitle : UXCopy.notifVideoTitle
            content.body = savedToPhotos ? UXCopy.notifVideoBodyPhotos : UXCopy.notifFailedBody
        } else {
            content.title = UXCopy.notifFailedTitle
            content.body = UXCopy.notifFailedBody
        }
        content.sound = .default
        let request = UNNotificationRequest(identifier: "export-\(UUID().uuidString)", content: content, trigger: nil)
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }
            UNUserNotificationCenter.current().add(request)
        }
    }

    // MARK: - Background time

    private func beginBackground() {
        guard backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "FinalCapExport") { [weak self] in
            Task { @MainActor in self?.endBackground() }
        }
    }

    private func endBackground() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }
}
