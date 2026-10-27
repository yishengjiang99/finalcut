import AVFoundation
import Foundation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Timeline (multi-clip) behaviour of the editor. The project lives on the edit stack
/// (`EditStack.project`); every mutation goes through `ProjectCommandExecutor` — the
/// same layer the AI tools use — and is saved to the durable ProjectStore and reflected
/// in the preview. Single-clip sessions never touch this file's paths until media is
/// appended or a timeline tool runs.
extension EditorViewModel {
    var timelineProject: EditorProject? { editStack?.project }

    var hasTimelineProject: Bool { editStack?.isTimelineProject == true }

    // MARK: Project lifecycle

    /// Materialises the timeline project for the current session (adapter from the
    /// single-clip stack), adopting all media into durable project storage and saving.
    @discardableResult
    func ensureTimelineProject() async -> EditorProject? {
        guard var stack = await ensureStack() else { return nil }
        if let existing = stack.project { return existing }
        var project = stack.makeProject(name: stack.base.lastPathComponent)
        do {
            try ProjectStore.adoptExternalAssets(&project)
            try ProjectStore.save(project)
        } catch {
            // Storage failure must not break editing: keep the in-memory project (its
            // assets still resolve by absolute path) and surface the failure in chat.
            messages.append(ChatMessage(role: .system, content: "Couldn't save the project file — editing continues, but reopen the app with care."))
        }
        stack.project = project
        editStack = stack
        return project
    }

    /// Reopens a saved project after a relaunch, but only into an untouched empty
    /// editor (never over a session already in progress). Issue #125 Phase 1: the
    /// restore target is the LAST-OPENED project — its id is persisted by
    /// `ProjectLibrary` every time a project is opened. This replaces the old
    /// implementation, which picked `loadAll().first(where:)` in unsorted
    /// directory order (any saved project could come back) and skipped
    /// single-clip projects entirely; that >1-clip / audio-track guard is gone,
    /// so any saved project can be restored.
    func restoreSavedProjectIfEmpty() async {
        guard localVideoURL == nil, state == .empty, messages.isEmpty else { return }
        if let lastID = ProjectLibrary.lastOpenedProjectID(),
           let project = try? ProjectStore.load(lastID),
           await openProject(project) {
            return
        }
        // No usable last-opened id (first launch on this version, or that
        // project was deleted): fall back to the most recently edited project
        // so an upgraded install still lands in its newest work rather than an
        // empty editor.
        if let newest = ProjectLibrary.loadRows().first,
           let project = try? ProjectStore.load(newest.id) {
            await openProject(project)
        }
    }

    /// Loads a saved project into the editor session by id (project library).
    @discardableResult
    func openProject(id: UUID) async -> Bool {
        guard let project = try? ProjectStore.load(id) else { return false }
        return await openProject(project)
    }

    /// Loads a saved project into the editor session, replacing the session
    /// currently shown, and records it as the last-opened project (the next
    /// relaunch restores it). The outgoing session is preserved first: a
    /// timeline project is already saved after every mutation (saved again
    /// here for safety), and a legacy single-clip video session is materialised
    /// into a durable project so switching never silently drops it. Photo
    /// sessions have no project form yet and are simply replaced. The chat
    /// starts fresh with an "Opened …" line — transcripts are session-scoped
    /// until Phase 2 persists them per project. Returns false when the project
    /// can't be previewed (no video clips, or its first clip's file is gone).
    @discardableResult
    func openProject(_ project: EditorProject) async -> Bool {
        if timelineProject?.id == project.id {
            ProjectLibrary.markOpened(projectID: project.id)
            return true
        }
        guard let firstClip = project.videoClips.first,
              let firstAsset = project.asset(firstClip.assetID) else { return false }
        let baseURL = NativeComposer.resolveAssetURL(firstAsset, in: project)
        guard FileManager.default.fileExists(atPath: baseURL.path),
              let canvas = await Self.loadCanvas(baseURL) else { return false }

        if timelineProject != nil {
            saveTimelineProject()
        } else if localVideoURL != nil, !isPhoto {
            _ = await ensureTimelineProject()
        }

        var stack = EditStack(base: baseURL, baseCanvas: canvas)
        stack.project = project
        undoManager?.removeAllActions(withTarget: self)
        localVideoURL = baseURL
        editStack = stack
        captionArtifacts = CaptionArtifacts()
        importError = nil
        importStatus = nil
        startNewProjectOnNextImport = false
        state = .ready
        ProjectLibrary.setLastOpenedProjectID(project.id)
        ProjectLibrary.markOpened(projectID: project.id)
        let missing = ProjectStore.missingAssets(project)
        messages = [ChatMessage(role: .system, content: missing.isEmpty
            ? "Opened \(project.name) (\(project.videoClips.count) clips)."
            : "Opened \(project.name) — \(missing.count) file(s) are missing: \(missing.map(\.name).joined(separator: ", ")).")]
        await refreshPreview()
        return true
    }

    /// Renames a project from the library. The open project is renamed in place
    /// (and saved), so its in-memory copy can't clobber the new name on the
    /// next autosave; any other project is renamed on disk via the library.
    func renameProject(id: UUID, to newName: String) async {
        if timelineProject?.id == id, var stack = editStack, stack.project != nil {
            stack.project?.name = newName
            editStack = stack
            saveTimelineProject()
        } else {
            try? ProjectLibrary.rename(projectID: id, to: newName)
        }
    }

    /// Deletes a project from the library (directory and copied media,
    /// permanently). Deleting the project currently open first clears the
    /// session via the same path as "New project", so the editor never keeps
    /// editing a project whose files are gone. Returns the bytes freed.
    @discardableResult
    func deleteProject(id: UUID) throws -> Int64 {
        if timelineProject?.id == id {
            startNewTimelineProject()
        }
        return try ProjectLibrary.delete(projectID: id)
    }

    /// Saves the current project (called after every successful timeline mutation).
    func saveTimelineProject() {
        guard let project = timelineProject else { return }
        try? ProjectStore.save(project)
    }

    // MARK: Shared command entry (UI + AI)

    /// Runs one timeline command: validation + atomic apply happen in the executor,
    /// undo registration in `commitEdit`, then save + preview. Returns the result for
    /// tool reporting; nil (with the error already surfaced) on failure.
    @discardableResult
    func performTimelineCommand(_ command: ProjectCommand) async -> ProjectCommandResult? {
        guard await ensureTimelineProject() != nil, var stack = editStack else { return nil }
        do {
            let result = try stack.performProjectCommand(command)
            commitEdit(stack)
            saveTimelineProject()
            await refreshPreview()
            return result
        } catch let error as ProjectCommandError {
            lastError = error.code
            return nil
        } catch let error as EditorProject.ValidationError {
            lastError = error.codes.first
            return nil
        } catch {
            lastError = "timeline_command_failed"
            return nil
        }
    }

    // MARK: Import — append flows

    /// Appends one local media file (video or audio) to the current project. The file's
    /// actual tracks decide its type — the extension is never trusted. A photo is NOT
    /// silently folded into a video project: with no session it starts photo mode via
    /// the legacy path; with a video session it is refused with a message.
    @discardableResult
    func appendImportedMedia(_ url: URL, audioTrackName: String = "Music", audioKind: AudioTrackKind = .music, audioAtProjectStart: Bool = true) async -> Bool {
        let probePath = url.path
        let probe = try? await MediaProbe.probe(url: url, relativePath: probePath)
        guard let probe else {
            messages.append(ChatMessage(role: .system, content: "Couldn't read \(url.lastPathComponent) — it wasn't added."))
            return false
        }
        if probe.mediaType == .image {
            if localVideoURL == nil {
                await handleImport(.success([url]))
                return true
            }
            messages.append(ChatMessage(role: .system, content: "Photos stay in photo mode — \(url.lastPathComponent) wasn't added to the video project."))
            return false
        }
        guard await ensureTimelineProject() != nil, let project = timelineProject else { return false }

        // Dedupe: the same file content reuses the stored asset (the timeline can still
        // place it more than once through separate clips).
        var asset = probe
        if let duplicate = await ProjectStore.existingDuplicate(of: url, in: project) {
            asset = duplicate
        } else {
            do {
                let assetID = UUID()
                let relative = try ProjectStore.copyIntoProject(source: url, projectID: project.id, assetID: assetID)
                asset = try await MediaProbe.probe(
                    url: ProjectStore.projectDirectory(project.id).appendingPathComponent(relative),
                    relativePath: relative, id: assetID, name: url.lastPathComponent)
            } catch ProjectStore.StoreError.insufficientSpace {
                messages.append(ChatMessage(role: .system, content: "Not enough free space to add \(url.lastPathComponent)."))
                return false
            } catch {
                messages.append(ChatMessage(role: .system, content: "Couldn't copy \(url.lastPathComponent) into the project — it wasn't added."))
                return false
            }
            _ = await performTimelineCommand(.addAsset(asset))
        }

        switch asset.mediaType {
        case .video:
            let result = await performTimelineCommand(.appendVideoClip(assetID: asset.id, sourceStart: nil, sourceEnd: nil))
            if result != nil {
                messages.append(ChatMessage(role: .system, content: "Added \(asset.name) to the timeline."))
                return true
            }
        case .audio:
            var trackID = timelineProject?.audioTracks.first(where: { $0.name == audioTrackName })?.id
            if trackID == nil {
                trackID = await performTimelineCommand(.createAudioTrack(name: audioTrackName, kind: audioKind))?.createdID
            }
            guard let trackID else { return false }
            let result = await performTimelineCommand(.insertAudioClip(
                trackID: trackID, assetID: asset.id,
                timelineStart: audioAtProjectStart ? 0 : (timelineProject?.durationSeconds ?? 0),
                sourceStart: nil, sourceDuration: nil, gain: nil, loop: false, repeatUntil: nil))
            if result != nil {
                messages.append(ChatMessage(role: .system, content: "Added \(asset.name) as audio."))
                return true
            }
        case .image:
            return false
        }
        return false
    }

    /// Multi-file Files import: successes are kept even when siblings fail; the outcome
    /// line names every failure.
    func importMediaFiles(_ urls: [URL]) async {
        guard !urls.isEmpty else { return }
        state = .importing
        var failures: [String] = []
        for (index, url) in urls.enumerated() {
            if Task.isCancelled { break }
            importStatus = "Importing \(index + 1) of \(urls.count)…"
            let accessed = url.startAccessingSecurityScopedResource()
            // Into an EMPTY editor the first video/photo takes the legacy first-import
            // path (it becomes the session base); everything else appends.
            let ok: Bool
            if localVideoURL == nil, !["m4a", "mp3", "wav", "aac", "caf", "aif", "aiff"].contains(url.pathExtension.lowercased()) {
                await handleImport(.success([url]))
                ok = localVideoURL != nil
            } else {
                ok = await appendImportedMedia(url)
            }
            if accessed { url.stopAccessingSecurityScopedResource() }
            if !ok { failures.append(url.lastPathComponent) }
        }
        importStatus = nil
        state = localVideoURL == nil ? .empty : .ready
        if !failures.isEmpty {
            messages.append(ChatMessage(role: .system, content: "Couldn't import: \(failures.joined(separator: ", ")). Everything else was kept."))
        }
    }

    /// Multi-select Photos import, in the user's selection order. The first item of an
    /// empty session takes the legacy single-import path (photo mode included); the
    /// rest append to the project.
    func loadPhotosPickerItems(_ items: [PhotosPickerItem]) async {
        guard !items.isEmpty else { return }
        defer { photosPickerItems = [] }
        state = .importing
        var failures = 0
        for (index, item) in items.enumerated() {
            if Task.isCancelled { break }
            importStatus = "Importing \(index + 1) of \(items.count)…"
            do {
                guard let video = try await item.loadTransferable(type: ImportedVideo.self) else {
                    failures += 1
                    continue
                }
                if index == 0, localVideoURL == nil {
                    // Legacy single-import path (photo mode included).
                    await handleImport(.success([video.url]))
                } else {
                    _ = await appendImportedMedia(video.url)
                }
            } catch {
                failures += 1
            }
        }
        importStatus = nil
        if state == .importing { state = localVideoURL == nil ? .empty : .ready }
        if failures > 0 {
            messages.append(ChatMessage(role: .system, content: "\(failures) item(s) couldn't be imported — the rest were kept."))
        }
    }

    /// "New project" (timeline menu): clears the session; the next import adapts into a
    /// brand-new durable project. The saved previous project stays on disk untouched.
    func startNewTimelineProject() {
        resetSessionForNewProject()
        messages.append(ChatMessage(role: .system, content: "New project — import clips to begin. Your previous project is still saved."))
    }
}
