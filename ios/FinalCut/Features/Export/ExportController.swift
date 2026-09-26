import Foundation
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
        let isPhoto = Self.isPhoto(stack: stack, fallbackURL: fallbackURL)
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
                case .files:
                    self.phase = .idle
                    self.filesPickerURL = url
                }
            } catch NativeExporter.ExportError.cancelled {
                self.phase = .idle
            } catch is CancellationError {
                self.phase = .idle
            } catch PhotoLibrarySaver.SaveError.notAuthorized {
                self.phase = .idle
                self.photosPermissionDenied = true
            } catch {
                self.phase = .failed(UXCopy.notifFailedTitle)
                self.notifyIfInactive(success: false, isPhoto: isPhoto, savedToPhotos: false)
            }
            self.endBackground()
        }
    }

    func cancel() {
        exporter.cancel()
        task?.cancel()
    }

    /// Renders once per session (cached). No edits → the original file.
    func render(stack: EditStack?, fallbackURL: URL?) async throws -> URL {
        if let renderedURL { return renderedURL }
        let isPhoto = Self.isPhoto(stack: stack, fallbackURL: fallbackURL)
        guard let base = stack?.base ?? fallbackURL else { throw NativeExporter.ExportError.failed }
        let url: URL
        if let stack, !stack.entries.isEmpty {
            beginBackground()
            offerNotificationsIfFirstExport(isPhoto: isPhoto)
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

    // MARK: - Notifications (Design §6)

    /// The first video export shows "Notify me when it's done" once; permission only on tap.
    private func offerNotificationsIfFirstExport(isPhoto: Bool) {
        guard !isPhoto, !defaults.bool(forKey: NativeSettings.notifyOfferShownKey) else { return }
        defaults.set(true, forKey: NativeSettings.notifyOfferShownKey)
        showNotifyOffer = true
    }

    func requestNotifications() {
        showNotifyOffer = false
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
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
