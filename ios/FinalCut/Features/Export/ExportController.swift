import Foundation
import SwiftUI
import UIKit
import UserNotifications

/// Runs one export: video = render on device (real %, cancel) then save to Photos;
/// photo = Core Image render in the original/requested format then save.
/// Keeps running briefly in the background and posts a local notification when the app
/// isn't active (only if the user allowed notifications).
@MainActor
final class ExportController: ObservableObject {
    enum Phase: Equatable {
        case idle
        case rendering(Int)
        case saving
        case done
        case failed(String)
        case cancelled
    }

    @Published var phase: Phase = .idle
    @Published var showNotifyOffer = false

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

    func start(stack: EditStack?, fallbackURL: URL?) {
        guard !isRunning else { return }
        let isPhoto = stack?.isPhoto ?? fallbackURL.map { MediaMIME.isImage(url: $0) } ?? false
        phase = isPhoto ? .saving : .rendering(0)
        offerNotificationsIfFirstExport(isPhoto: isPhoto)
        beginBackground()
        task = Task { [weak self] in
            guard let self else { return }
            do {
                if isPhoto {
                    try await self.exportPhoto(stack: stack, fallbackURL: fallbackURL)
                } else {
                    try await self.exportVideo(stack: stack, fallbackURL: fallbackURL)
                }
                self.phase = .done
                self.notifyIfInactive(success: true, isPhoto: isPhoto)
            } catch NativeExporter.ExportError.cancelled {
                self.phase = .cancelled
            } catch is CancellationError {
                self.phase = .cancelled
            } catch PhotoLibrarySaver.SaveError.notAuthorized {
                self.phase = .failed(UXCopy.saveFailed)
                self.notifyIfInactive(success: false, isPhoto: isPhoto)
            } catch {
                self.phase = .failed(UXCopy.notifFailedTitle)
                self.notifyIfInactive(success: false, isPhoto: isPhoto)
            }
            self.endBackground()
        }
    }

    func cancel() {
        exporter.cancel()
        task?.cancel()
    }

    private func exportVideo(stack: EditStack?, fallbackURL: URL?) async throws {
        let url: URL
        if let stack, !stack.entries.isEmpty {
            let composed = try await NativeComposer.compose(stack)
            url = try await exporter.export(composed, format: stack.outputFormat) { [weak self] value in
                guard let self, case .rendering = self.phase else { return }
                self.phase = .rendering(min(99, max(0, Int((value * 100).rounded(.down)))))
            }
        } else if let base = stack?.base ?? fallbackURL {
            url = base // No edits: save the clip as-is.
        } else {
            throw NativeExporter.ExportError.failed
        }
        try Task.checkCancellation()
        phase = .saving
        try await PhotoLibrarySaver.saveVideo(at: url)
    }

    private func exportPhoto(stack: EditStack?, fallbackURL: URL?) async throws {
        let url: URL
        if let stack, !stack.entries.isEmpty {
            url = try await Task.detached(priority: .userInitiated) { try PhotoRenderer.exportFile(stack) }.value
        } else if let base = stack?.base ?? fallbackURL {
            url = base
        } else {
            throw PhotoLibrarySaver.SaveError.failed
        }
        try await PhotoLibrarySaver.savePhoto(at: url)
    }

    // MARK: - Notifications (Design §6)

    /// The first export shows "Notify me when it's done" once; permission is only asked on tap.
    private func offerNotificationsIfFirstExport(isPhoto: Bool) {
        guard !isPhoto, !defaults.bool(forKey: NativeSettings.notifyOfferShownKey) else { return }
        defaults.set(true, forKey: NativeSettings.notifyOfferShownKey)
        showNotifyOffer = true
    }

    func requestNotifications() {
        showNotifyOffer = false
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    private func notifyIfInactive(success: Bool, isPhoto: Bool) {
        guard UIApplication.shared.applicationState != .active else { return }
        let content = UNMutableNotificationContent()
        if success {
            content.title = isPhoto ? UXCopy.notifPhotoTitle : UXCopy.notifVideoTitle
            content.body = UXCopy.notifVideoBodyPhotos
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
