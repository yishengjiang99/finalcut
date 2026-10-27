import SwiftUI
import PhotosUI
import AVFoundation

/// Editor — single root and first screen at launch (not tabs). Regions top→bottom:
/// TopBar → Preview (or Import panel when empty) → Chat → SampleChips → Composer.
/// ExportSheet and PaywallView are sheets.
struct EditorView: View {
    @EnvironmentObject private var appModel: AppModel
    @StateObject private var model = EditorViewModel()
    @State private var showExport = false
    @State private var showSettings = false
    /// Project history library (issue #125, Phase 1), presented from the top bar.
    @State private var showHistory = false
    @StateObject private var dictation = DictationController()
    /// Layout rethink (2026-10-27): with a timeline project open the editor is in
    /// edit focus (tall timeline, chat peeked) or chat focus (compact timeline strip,
    /// full chat) — toggled by the grab handle above the chat.
    @State private var chatExpanded = false
    /// Observed so chips and routing refresh when Settings → Cloud processing changes.
    @AppStorage(NativeSettings.cloudProcessingKey) private var cloudProcessing = false
    /// The window's undo manager: shake to undo / redo drives the edit stack.
    @Environment(\.undoManager) private var undoManager

    var body: some View {
        VStack(spacing: 0) {
            TopBarView(
                photosPickerItem: $model.photosPickerItem,
                onExport: { showExport = true },
                onUpgrade: { appModel.presentPaywall(reason: .upgradeTapped) },
                importEnabled: importEnabled,
                exportVisible: model.localVideoURL != nil,
                exportEnabled: !model.state.isBusy,
                showUpgrade: !appModel.hasSubscription,
                freeRemaining: TopBarView.visibleFreeRemaining(unlimited: appModel.isUnlimited, remaining: appModel.dailyRemaining),
                onSettings: { showSettings = true },
                onShowHistory: { showHistory = true },
                editControlsVisible: model.localVideoURL != nil,
                canUndo: model.canUndo,
                canRedo: model.canRedo,
                onUndo: { model.performUndo() },
                onRedo: { model.performRedo() },
                cameraAvailable: UIImagePickerController.isSourceTypeAvailable(.camera),
                onChooseFile: { url in Task { await model.importFile(url) } },
                onCapture: { url in Task { await model.handleImport(.success([url])) } }
            )

            if showsImportPanel {
                ImportPanelView(
                    photosPickerItem: $model.photosPickerItem,
                    onTrySample: { model.loadSampleClip() },
                    importError: model.importError
                )
                .frame(maxHeight: 240)
            } else {
                PreviewPaneView(
                    state: model.state,
                    videoURL: model.localVideoURL,
                    processingMessage: model.lyricStatus ?? model.processingOverlay.message,
                    playerItem: model.previewItem,
                    photo: model.previewPhoto,
                    showsDimmer: model.isCloudStepRunning,
                    canUndo: false,
                    onCancel: model.lyricStatus != nil ? { model.cancelStreamingCaptions() } : nil,
                    seekSeconds: model.seekSeconds
                )
                .frame(maxHeight: timelineExpandedActive ? (chatExpanded ? 64 : 200) : 240)
                if !model.isPhoto, model.localVideoURL != nil {
                    TimelineView(model: model,
                                 compact: timelineExpandedActive && chatExpanded,
                                 onExpand: { withAnimation(.easeInOut(duration: 0.25)) { chatExpanded = false } })
                }
                if let importError = model.importError {
                    ImportErrorBanner(message: importError, photosPickerItem: $model.photosPickerItem)
                }
            }

            Divider().overlay(AppTheme.border)

            if timelineExpandedActive {
                chatHandle
            }

            ChatView(
                messages: model.messages,
                onRetry: { model.retry($0) },
                queuedIDs: Set(model.queuedPromptIDs),
                isWorking: model.isBusy
            )
                .frame(maxHeight: (timelineExpandedActive && !chatExpanded) ? 132 : .infinity)

            if model.showSampleChips && model.localVideoURL != nil {
                SampleChipsView(pills: model.suggestions) { pill in
                    model.applySuggestion(pill)
                }
            }

            ComposerView(
                text: $model.composerText,
                photosPickerItem: $model.photosPickerItem,
                onSend: { model.sendMessage() },
                importEnabled: importEnabled,
                dictation: dictation
            )
        }
        .background(AppTheme.background.ignoresSafeArea())
        .background(KeyboardDismissInstaller().frame(width: 0, height: 0))
        .accessibilityIdentifier("Editor")
        .sheet(isPresented: $showExport) {
            ExportSheet(videoURL: model.localVideoURL, state: model.state, stack: model.editStack)
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
        .sheet(isPresented: $showHistory) {
            ProjectLibraryView(model: model)
        }
        .alert(
            model.pendingPrompt?.title ?? "",
            isPresented: Binding(
                get: { model.pendingPrompt != nil },
                set: { if !$0 { model.resolvePrompt(primary: false) } }
            ),
            presenting: model.pendingPrompt
        ) { prompt in
            Button(prompt.primary) { model.resolvePrompt(primary: true) }
            Button(prompt.secondary, role: .cancel) { model.resolvePrompt(primary: false) }
        } message: { prompt in
            Text(prompt.message)
        }
        .sheet(isPresented: $appModel.isPaywallPresented) {
            PaywallView()
                .environmentObject(appModel)
        }
        .onChange(of: model.photosPickerItem) { _, item in
            Task { await model.loadPhotosPickerItem(item) }
        }
        .onChange(of: model.photosPickerItems) { _, items in
            Task { await model.loadPhotosPickerItems(items) }
        }
        .onChange(of: model.localVideoURL) { _, url in
            // The editor surface now has a project/clip loaded.
            if url != nil { Telemetry.shared.track("editor_open") }
        }
        .onAppear {
            // No project is auto-restored on launch: every relaunch starts a
            // new project (issue #125 owner decision, 2026-10-27); past
            // projects live in the library behind the top bar's Projects button.
            model.refreshSuggestions()
            model.undoManager = undoManager
            model.apiClient = appModel.apiClient
            model.onOpenSettings = { showSettings = true }
            model.onPaywallRequired = { [weak appModel] in
                appModel?.presentPaywall(reason: .usageLimitReached)
            }
            model.onInferenceFinished = { [weak appModel] in
                Task { await appModel?.refreshQuota() }
            }
            // Dictation fills the composer live and queues each finished request.
            dictation.onTranscript = { [weak model] text in model?.composerText = text }
            dictation.onSend = { [weak model] text in
                model?.composerText = ""
                model?.submitPrompt(text)
            }
        }
        .onDisappear { dictation.stop() }
        .onChange(of: undoManager) { _, manager in model.undoManager = manager }
        .onChange(of: model.isPhoto) { _, _ in model.refreshSuggestions() }
        .onChange(of: model.showTimeline) { _, shown in
            if !shown { chatExpanded = false }
        }
        .overlay(alignment: .top) {
            if model.state == .failed, model.importError == nil, let err = model.lastError {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(.white)
                    .padding(8)
                    .background(AppTheme.danger)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .padding(.top, 56)
            }
        }
    }

    private var importEnabled: Bool {
        !model.state.isBusy
    }

    /// Launch / empty state shows the import panel in place of the preview.
    private var showsImportPanel: Bool {
        model.localVideoURL == nil && (model.state == .empty || model.state == .failed)
    }

    /// True while a multi-clip timeline project is the editor's focus surface —
    /// the two layout modes (edit focus / chat focus) only apply then; the legacy
    /// single-video flow keeps the original layout untouched.
    private var timelineExpandedActive: Bool {
        !model.isPhoto && model.localVideoURL != nil && model.showTimeline && model.timelineProject != nil
    }

    /// Grab-handle row between the timeline and the chat sheet: toggles edit focus
    /// and chat focus.
    private var chatHandle: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.25)) { chatExpanded.toggle() }
        } label: {
            VStack(spacing: 3) {
                Capsule().fill(AppTheme.border).frame(width: 38, height: 4.5)
                HStack(spacing: 5) {
                    Image(systemName: "text.bubble")
                    Text(chatExpanded ? "Back to editing" : "Chat")
                    Image(systemName: chatExpanded ? "chevron.down" : "chevron.up")
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(AppTheme.textSecondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 5)
            .background(AppTheme.surface)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(chatExpanded ? "Back to editing" : "Expand chat")
    }
}

/// Empty-state panel: pick a video from Photos (primary) or try the bundled sample clip.
struct ImportPanelView: View {
    @Binding var photosPickerItem: PhotosPickerItem?
    var onTrySample: () -> Void
    /// Import-step error (`import.failed.format`), shown with "Choose another".
    var importError: String? = nil

    var body: some View {
        ZStack {
            AppTheme.surface
            VStack(spacing: 14) {
                Image(systemName: "video.badge.plus")
                    .font(.system(size: 36))
                    .foregroundStyle(AppTheme.accent)
                Text("Import a photo or video to start editing")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(AppTheme.textPrimary)
                if let importError {
                    Text(importError)
                        .font(.footnote)
                        .foregroundStyle(AppTheme.danger)
                        .multilineTextAlignment(.center)
                        .accessibilityIdentifier("ImportError")
                }
                PhotosPicker(
                    selection: $photosPickerItem,
                    matching: EditorViewModel.pickerFilter,
                    photoLibrary: .shared()
                ) {
                    Label(importError == nil ? "Choose from Photos" : UXCopy.chooseAnother, systemImage: "photo.on.rectangle")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.black)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 10)
                        .background(AppTheme.accent)
                        .clipShape(Capsule())
                }
                .accessibilityIdentifier("ImportFromPhotos")
                Button("Try the sample clip", action: onTrySample)
                    .font(.footnote)
                    .foregroundStyle(AppTheme.textSecondary)
            }
            .padding(16)
        }
        .accessibilityIdentifier("ImportPanel")
    }
}

/// Import-step error while a clip is still loaded: copy + "Choose another" (reopens Photos).
struct ImportErrorBanner: View {
    var message: String
    @Binding var photosPickerItem: PhotosPickerItem?

    var body: some View {
        HStack(spacing: 10) {
            Text(message)
                .font(.footnote)
                .foregroundStyle(AppTheme.textPrimary)
            Spacer(minLength: 8)
            PhotosPicker(selection: $photosPickerItem, matching: EditorViewModel.pickerFilter, photoLibrary: .shared()) {
                Text(UXCopy.chooseAnother)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(AppTheme.accent)
            }
            .accessibilityIdentifier("ImportChooseAnother")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(AppTheme.danger.opacity(0.15))
        .accessibilityIdentifier("ImportError")
    }
}

@MainActor
final class EditorViewModel: ObservableObject {
    @Published var state: EditorState = .empty
    @Published var messages: [ChatMessage] = []
    @Published var composerText = ""
    @Published var localVideoURL: URL?
    @Published var photosPickerItem: PhotosPickerItem?
    /// Multi-select Photos picker (timeline "Add" flows).
    @Published var photosPickerItems: [PhotosPickerItem] = []
    /// Compact timeline workspace visibility (chat-first layout: collapsed by default).
    @Published var showTimeline = false
    /// Progress / outcome line for multi-file imports ("Importing 2 of 5…", failures).
    @Published var importStatus: String?
    /// Set by "New project" in the timeline: the next base import starts a fresh
    /// durable project instead of adapting the current session.
    var startNewProjectOnNextImport = false
    /// Playhead target (seconds) requested from the timeline scrubber.
    @Published var seekSeconds: Double?
    /// Idempotency cache for timeline tool calls (server contract): a retried call
    /// carrying the same key returns the original result without re-applying.
    var timelineIdempotencyCache: [String: ClientToolResult] = [:]
    @Published var showSampleChips = true
    @Published var lastError: String?
    @Published var activeJobId: String?
    @Published var processingOverlay: ProcessingOverlayKind = .editing
    @Published var captionArtifacts = CaptionArtifacts()
    /// Import-step error (`import.failed.format`); never an edit card.
    @Published var importError: String?
    /// Two-button confirmation currently on screen (cloud upload consent, Cloud-off notice).
    @Published var pendingPrompt: CloudPrompt?
    /// Progress line for lyric captions ("Uploading audio…", "Listening to the song…", …).
    @Published var lyricStatus: String?
    /// Tests answer prompts without UI (return true for the primary button).
    var promptHandler: ((CloudPrompt) async -> Bool)?
    /// "Open Settings" on the Cloud-off notice: shows the app's Cloud processing setting.
    var onOpenSettings: (() -> Void)?
    private var promptContinuation: CheckedContinuation<Bool, Never>?
    /// Latest `turnToken` of the running client-mode chat turn (sent with the lyric captions upload).
    var currentTurnToken: String?
    /// Tests inject the socket, pacing, sleeping and watchdog timings.
    var streamingDepsTweak: ((inout StreamingDeps) -> Void)?
    var captionSocketFactory: (URL) -> CaptionSocket = { URLSessionCaptionSocket(url: $0) }

    /// Stop translated captions in flight: closes the socket and stops the translate calls
    /// (the cancelled task tears the engine down); nothing is applied.
    func cancelStreamingCaptions() {
        guard lyricStatus != nil else { return }
        processingTask?.cancel()
        lyricStatus = nil
        isCloudStepRunning = false
        processingOverlay = .editing
        activeJobId = nil
        state = localVideoURL == nil ? .empty : .ready
        messages.append(ChatMessage(role: .assistant, content: "Captions cancelled. Nothing was changed."))
    }

    /// Photos and videos (photo mode, NATIVE_EDIT_UX.md §7).
    nonisolated static var pickerFilter: PHPickerFilter { .any(of: [.images, .videos]) }

    /// The loaded asset is a photo (JPEG/PNG after on-device normalisation).
    var isPhoto: Bool {
        localVideoURL.map { MediaMIME.isImage(url: $0) } ?? false
    }

    /// Per-turn results so failed cards follow the §8 rules.
    private var turnOutcome = EditTurnOutcome()
    private var turnPrompt = ""

    // MARK: Native editing state
    /// Non-destructive edit stack for the loaded clip/photo (base file never modified).
    @Published var editStack: EditStack?
    /// Composed preview for videos (rebuilt from the stack; nothing rendered until export).
    @Published var previewItem: AVPlayerItem?
    /// Rendered preview for photos.
    @Published var previewPhoto: UIImage?
    /// True only while a cloud step runs (the only edit that may dim the preview).
    @Published var isCloudStepRunning = false
    /// Prompts waiting for the current edit to finish (dictation queue, FIFO).
    @Published var queuedPromptIDs: [UUID] = []
    private var queuedPrompts: [(id: UUID, text: String)] = []
    private(set) var composedVideo: ComposedVideo?
    private var previewGeneration = 0

    /// Settings → Cloud processing (default off). Off means nothing is ever uploaded.
    var cloudProcessingEnabled: Bool {
        UserDefaults.standard.bool(forKey: NativeSettings.cloudProcessingKey)
    }

    /// Shared API client from AppModel (jobs for long FFmpeg edits; captions sync).
    var apiClient: APIClient?
    /// On-device speech-to-text for `generate_captions` (swapped in tests).
    var captioner: CaptionTranscribing = OnDeviceCaptioner()
    /// Server reported the free usage limit (402 `paywall` / 429 `daily_limit_reached`).
    var onPaywallRequired: (() -> Void)?
    /// An inference request completed (success or failure) — refresh quota display.
    var onInferenceFinished: (() -> Void)?

    /// Sample chips (photo-safe set for photos). Each maps to a correct tool with complete args.
    var sampleChips: [String] { EditorRoute.chips(isPhoto: isPhoto) }

    // MARK: Suggestion pills (server-driven, cached, bundled fallback)

    var suggestionService = SuggestionService()
    @Published private(set) var suggestions: [SuggestionPill] = SuggestionService.bundledVideo
    private var suggestionsMedia: SuggestionMedia?

    /// On launch and whenever the media type changes: show cache/bundled now, then refresh.
    func refreshSuggestions() {
        let media: SuggestionMedia = isPhoto ? .photo : .video
        guard media != suggestionsMedia else { return }
        suggestionsMedia = media
        let service = suggestionService
        suggestions = service.immediate(for: media)
        Task { [weak self] in
            let pills = await service.suggestions(for: media)
            guard let self, self.suggestionsMedia == media, !pills.isEmpty else { return }
            self.suggestions = pills
        }
    }

    /// A pill sends its full prompt (the label is only what the pill shows).
    func applySuggestion(_ pill: SuggestionPill) {
        submitPrompt(pill.prompt)
    }

    /// Choose File: security-scoped read, copied into the app sandbox by the shared import path.
    /// With a session already open, a chosen file APPENDS to the timeline project
    /// (audio included); in an empty editor it takes the legacy first-import path.
    func importFile(_ url: URL) async {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        if localVideoURL != nil {
            _ = await appendImportedMedia(url)
        } else {
            await handleImport(.success([url]))
        }
    }

    private var processingTask: Task<Void, Never>?

    enum CaptionIntent: Equatable {
        case generate
        case translate(language: String)
        case burnIn
        case otherEdit
    }

    /// Imports a local file URL (copied into app-owned temp storage). The UI imports from
    /// Photos via `PhotosPicker` → `loadPhotosPickerItem`; this path is kept for tests/local URLs.
    func handleImport(_ result: Result<[URL], Error>) async {
        switch result {
        case .success(let urls):
            guard let url = urls.first else { return }
            state = .importing
            lastError = nil
            do {
                let video = try await Task.detached {
                    try ImportedVideo.copy(from: url)
                }.value
                finishImport(video, message: "Imported \(video.url.lastPathComponent)")
                // Multi-file imports: the first file takes the legacy path, the rest
                // append to the (newly materialised) timeline project in order.
                for extra in urls.dropFirst() {
                    let copied = try await Task.detached { try ImportedVideo.copy(from: extra) }.value
                    _ = await appendImportedMedia(copied.url)
                }
            } catch {
                failImport(isPhoto: MediaMIME.isImage(url: url) || error is PhotoTranscoder.TranscodeError)
            }
        case .failure:
            failImport(isPhoto: false)
        }
    }

    func loadPhotosPickerItem(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        state = .importing
        lastError = nil
        // Reset selection so choosing the same video again triggers another import.
        defer { photosPickerItem = nil }
        let pickedPhoto = item.supportedContentTypes.contains { $0.conforms(to: .image) }
            && !item.supportedContentTypes.contains { $0.conforms(to: .movie) }
        do {
            guard let video = try await item.loadTransferable(type: ImportedVideo.self) else {
                throw APIError.message(UXCopy.videoImportFailed)
            }
            finishImport(video, message: video.isPhoto ? "Imported photo from Photos" : "Imported from Photos")
        } catch {
            failImport(isPhoto: pickedPhoto || error is PhotoTranscoder.TranscodeError)
        }
    }

    private func finishImport(_ video: ImportedVideo, message: String) {
        localVideoURL = video.url
        captionArtifacts = CaptionArtifacts()
        importError = nil
        state = .ready
        messages.append(ChatMessage(role: .system, content: message))
        startEditing(video.url)
    }

    // MARK: - Native edit stack

    /// Resets the edit stack to a new base and shows it.
    func startEditing(_ url: URL) {
        editStack = nil
        undoManager?.removeAllActions(withTarget: self)
        composedVideo = nil
        previewItem = nil
        previewPhoto = nil
        Task { _ = await ensureStack() }
    }

    /// The stack for the current `localVideoURL` (created on demand).
    @discardableResult
    func ensureStack() async -> EditStack? {
        guard let url = localVideoURL else { return nil }
        if let stack = editStack, stack.base == url { return stack }
        guard let canvas = await Self.loadCanvas(url) else { return nil }
        let stack = EditStack(base: url, baseCanvas: canvas)
        editStack = stack
        await refreshPreview()
        return stack
    }

    /// Size/duration/audio of a file, with orientation applied.
    nonisolated static func loadCanvas(_ url: URL) async -> NativeCanvas? {
        if MediaMIME.isImage(url: url) {
            guard let size = PhotoTranscoder.orientedPixelSize(of: url) else { return nil }
            return NativeCanvas(width: size.width, height: size.height, duration: 0, isPhoto: true, hasAudio: false)
        }
        let asset = AVURLAsset(url: url)
        guard let track = try? await asset.loadTracks(withMediaType: .video).first,
              let (size, transform) = try? await track.load(.naturalSize, .preferredTransform) else { return nil }
        let oriented = CGRect(origin: .zero, size: size).applying(transform)
        let duration = (try? await asset.load(.duration)).map(CMTimeGetSeconds) ?? 0
        let hasAudio = !((try? await asset.loadTracks(withMediaType: .audio)) ?? []).isEmpty
        return NativeCanvas(
            width: Int(abs(oriented.width).rounded()),
            height: Int(abs(oriented.height).rounded()),
            duration: duration.isFinite ? duration : 0,
            isPhoto: false,
            hasAudio: hasAudio
        )
    }

    /// Rebuilds the preview from the stack. Video: new composed `AVPlayerItem` (instant,
    /// nothing is rendered). Photo: Core Image render of the edited photo.
    func refreshPreview() async {
        guard let stack = editStack else { return }
        previewGeneration += 1
        let generation = previewGeneration
        if stack.isPhoto {
            let image = await Task.detached(priority: .userInitiated) { try? PhotoRenderer.previewImage(stack) }.value
            guard generation == previewGeneration else { return }
            previewPhoto = image
            previewItem = nil
            composedVideo = nil
        } else if stack.isTimelineProject, let project = stack.project {
            // Multi-clip preview comes straight from the project composition — no
            // intermediate file is rendered. The generation counter drops results of
            // superseded edits so an older build can't overwrite a newer preview.
            // A compose failure leaves the preview black; report it (it was
            // previously swallowed by try?, which made export/preview failures
            // in opened projects undiagnosable).
            let composed: ComposedVideo
            do {
                composed = try await NativeComposer.compose(project: project)
            } catch {
                Telemetry.shared.track("preview_compose_fail", props: ["detail": "\(error)"])
                return
            }
            guard generation == previewGeneration else { return }
            composedVideo = composed
            previewItem = composed.makePlayerItem()
            previewPhoto = nil
        } else {
            guard let composed = try? await NativeComposer.compose(stack) else { return }
            guard generation == previewGeneration else { return }
            composedVideo = composed
            previewItem = composed.makePlayerItem()
            previewPhoto = nil
        }
    }

    // MARK: - Undo / Redo

    /// The window's undo manager (shake to undo). Set by the view; each step registers its
    /// inverse, and the edit stack stays the source of truth.
    weak var undoManager: UndoManager?

    /// A new edit on the stack: shows it, clears Redo (in `push`) and registers shake-to-undo.
    func commitEdit(_ stack: EditStack) {
        editStack = stack
        registerUndo(redo: false)
    }

    /// Undo the last edit (Design §3). Never touches the base file.
    func undoLastEdit(registering: Bool = true) {
        guard var stack = editStack, stack.undo() else { return }
        apply(stack)
        if registering { registerUndo(redo: true) }
    }

    /// Re-apply the last undone edit.
    func redoLastEdit(registering: Bool = true) {
        guard var stack = editStack, stack.redo() else { return }
        apply(stack)
        if registering { registerUndo(redo: false) }
    }

    /// Top-bar buttons go through the undo manager when it has the step, so its stack
    /// (shake to undo) stays in sync with ours; otherwise they act on the edit stack directly.
    func performUndo() {
        if let manager = undoManager, manager.canUndo { manager.undo() } else { undoLastEdit(registering: false) }
    }

    func performRedo() {
        if let manager = undoManager, manager.canRedo { manager.redo() } else { redoLastEdit(registering: false) }
    }

    var canUndo: Bool { editStack?.canUndo == true && !isBusy }
    var canRedo: Bool { editStack?.canRedo == true && !isBusy }

    private func apply(_ stack: EditStack) {
        editStack = stack
        localVideoURL = stack.base
        Task { await refreshPreview() }
    }

    /// Registers the inverse step: after an edit/redo that's Undo, after an undo it's Redo.
    private func registerUndo(redo: Bool) {
        guard let manager = undoManager else { return }
        manager.registerUndo(withTarget: self) { target in
            MainActor.assumeIsolated {
                if redo { target.redoLastEdit() } else { target.undoLastEdit() }
            }
        }
        manager.setActionName(UXCopy.editActionName)
    }

    /// Import failed: keep the current clip; photos get the import-step copy + "Choose another".
    private func failImport(isPhoto: Bool) {
        state = .failed
        if isPhoto {
            importError = UXCopy.importFailedFormat
            lastError = UXCopy.importFailedFormat
        } else {
            importError = nil
            lastError = UXCopy.videoImportFailed
        }
    }

    /// Server 415 `unsupported_image_format` (should be unreachable: photos are JPEG/PNG
    /// before upload). Shown at the import step, not as an edit card.
    private func showUnsupportedImageFormat() {
        localVideoURL = nil
        captionArtifacts = CaptionArtifacts()
        importError = UXCopy.importFailedFormat
        lastError = nil
        state = .empty
    }

    /// Retry from a generic failed edit card: resend the same prompt.
    func retry(_ card: EditFailureCard) {
        guard card.showsRetry, let prompt = card.retryPrompt else { return }
        guard !state.isBusy else { return }
        composerText = prompt
        sendMessage()
    }

    func loadBundledTestVideo() {
        guard canAutoLoadBundledTestVideo else { return }
        guard let url = bundledTestVideoURL else {
            state = .failed
            lastError = "Test video unavailable"
            return
        }
        processingTask?.cancel()
        activeJobId = nil
        messages = []
        composerText = ""
        localVideoURL = url
        photosPickerItem = nil
        lastError = nil
        captionArtifacts = CaptionArtifacts()
        processingOverlay = .editing
        state = .ready
        showSampleChips = true
        messages.append(ChatMessage(role: .system, content: "Loaded test video"))
    }

    /// User-initiated "Try the sample clip" from the empty-state import panel.
    func loadSampleClip() {
        guard !state.isBusy else { return }
        guard let url = bundledTestVideoURL else {
            state = .failed
            lastError = "Sample clip unavailable"
            return
        }
        localVideoURL = url
        lastError = nil
        importError = nil
        captionArtifacts = CaptionArtifacts()
        processingOverlay = .editing
        state = .ready
        showSampleChips = true
        messages.append(ChatMessage(role: .system, content: "Loaded sample clip"))
        startEditing(url)
    }

    /// Clears the whole session for a fresh timeline project (used by the timeline's
    /// "New project" action). Saved projects on disk are not touched.
    func resetSessionForNewProject() {
        processingTask?.cancel()
        activeJobId = nil
        localVideoURL = nil
        editStack = nil
        previewItem = nil
        previewPhoto = nil
        composedVideo = nil
        captionArtifacts = CaptionArtifacts()
        importError = nil
        importStatus = nil
        startNewProjectOnNextImport = true
        state = .empty
    }

    func resetBundledTestVideoIfNeeded() {
        guard shouldResetBundledTestVideo else { return }
        processingTask?.cancel()
        activeJobId = nil
        state = .empty
        messages = []
        composerText = ""
        self.localVideoURL = nil
        photosPickerItem = nil
        lastError = nil
        captionArtifacts = CaptionArtifacts()
        processingOverlay = .editing
        showSampleChips = true
    }

    func applySampleChip(_ chip: String) {
        composerText = chip
        sendMessage()
    }

    /// True while a turn (chat round-trip or edit) is running.
    var isBusy: Bool { state.isBusy }

    /// Sends a prompt now, or queues it (FIFO) while an edit is running. Queued prompts
    /// show immediately as a user bubble labelled "Queued" (Design #96).
    func submitPrompt(_ raw: String) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        if isBusy {
            let message = ChatMessage(role: .user, content: text)
            messages.append(message)
            queuedPrompts.append((message.id, text))
            queuedPromptIDs.append(message.id)
            return
        }
        composerText = text
        sendMessage()
    }

    /// Starts the next queued prompt once the editor is idle.
    private func drainQueueIfIdle() {
        guard !isBusy, !queuedPrompts.isEmpty else { return }
        let next = queuedPrompts.removeFirst()
        queuedPromptIDs.removeAll { $0 == next.id }
        startTurn(text: next.text)
    }

    func sendMessage() {
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        composerText = ""
        if isBusy {
            // Keep order: the running edit finishes first.
            let message = ChatMessage(role: .user, content: text)
            messages.append(message)
            queuedPrompts.append((message.id, text))
            queuedPromptIDs.append(message.id)
            return
        }
        messages.append(ChatMessage(role: .user, content: text))
        startTurn(text: text)
    }

    private func startTurn(text: String) {
        lastError = nil
        var resolved = EditorRoute.route(for: text)
        if case .captions = resolved, !cloudProcessingEnabled {
            // Server captions need an upload; with Cloud processing off the model decides.
            resolved = .chat(text)
        }
        let route = resolved
        turnOutcome = EditTurnOutcome()
        turnPrompt = text
        if case .captions = route, isPhoto {
            // Captions/translate/burn-in never apply to photos: no upload, no Retry.
            messages.append(.failure(EditFailureCard(kind: .photoUnsupported)))
            return
        }
        // A turn actually begins here (the photo-captions early return above
        // never starts inference, so it stays out of the funnel).
        let editSource: String
        switch route {
        case .chat: editSource = "chat"
        case .tool: editSource = "chip"
        case .captions: editSource = "captions"
        }
        Telemetry.shared.track("edit_start", props: ["source": editSource])
        switch route {
        case .captions(let intent):
            processingOverlay = Self.overlay(for: intent)
        case .tool, .chat:
            processingOverlay = .editing
        }
        state = .processing

        processingTask?.cancel()
        processingTask = Task {
            switch route {
            case .captions(.generate):
                await runGenerateCaptions()
            case .captions(.translate(let language)):
                await runTranslateCaptions(targetLanguage: language)
            case .captions(.burnIn), .captions(.otherEdit):
                await runBurnIn()
            case .tool(let name, let arguments):
                // Chip shortcut: same validation/execution path as a model tool call.
                let call = ClientToolCall(id: "chip-\(UUID().uuidString.prefix(8))", name: name, arguments: arguments)
                _ = await executeToolCall(call)
                finishTurn()
            case .chat(let prompt):
                await runChatTurn(prompt: prompt)
            }
            if !Task.isCancelled {
                onInferenceFinished?()
            }
            self.drainQueueIfIdle()
        }
    }

    static func detectCaptionIntent(_ prompt: String) -> CaptionIntent {
        let lower = prompt.lowercased()
        if lower.contains("burn") {
            return .burnIn
        }
        if lower.contains("translate") {
            if lower.contains("spanish") || lower.contains("español") || lower.contains("es ") || lower.hasSuffix(" es") {
                return .translate(language: "Spanish")
            }
            if lower.contains("french") || lower.contains("français") {
                return .translate(language: "French")
            }
            if lower.contains("chinese") || lower.contains("zh") {
                return .translate(language: "Chinese")
            }
            // "Translate to X" — take trailing token when present
            if let range = lower.range(of: "translate to ") {
                let rest = prompt[range.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
                if !rest.isEmpty {
                    return .translate(language: String(rest.prefix(32)))
                }
            }
            return .translate(language: "Spanish")
        }
        if lower.contains("caption") || lower.contains("subtitl") {
            return .generate
        }
        return .otherEdit
    }

    static func overlay(for intent: CaptionIntent) -> ProcessingOverlayKind {
        switch intent {
        case .generate: return .generatingCaptions
        case .translate: return .translating
        case .burnIn: return .burningSubtitles
        case .otherEdit: return .editing
        }
    }

    // MARK: - Captions three steps (sync; NOT one async captions job)

    private func ensureClientAndToken() async throws -> APIClient {
        guard let client = apiClient else {
            throw APIError.message("API client unavailable")
        }
        if client.sampleModeEnabled {
            _ = try await client.ensureSampleAccessToken()
        }
        return client
    }

    private func readLocalVideoData() throws -> (Data, URL) {
        guard let videoURL = localVideoURL else {
            throw APIError.message("Import a video first")
        }
        let accessed = videoURL.startAccessingSecurityScopedResource()
        defer { if accessed { videoURL.stopAccessingSecurityScopedResource() } }
        let data = try Data(contentsOf: videoURL)
        return (data, videoURL)
    }

    /// Server captions upload the clip, so they only run with Cloud processing on and after the
    /// user confirms. (With it off captions stay on the device: `OnDeviceCaptioner`.)
    private func confirmServerCaptionsUpload() async -> Bool {
        guard cloudProcessingEnabled else { return false }
        return await confirm(LyricCaptionsCopy.serverCaptionsPrompt)
    }

    func runGenerateCaptions(language: String = "auto", confirmed: Bool = false) async {
        if !confirmed, !(await confirmServerCaptionsUpload()) {
            // Not now (or Cloud processing off): nothing was sent.
            state = localVideoURL == nil ? .empty : .ready
            processingOverlay = .editing
            return
        }
        do {
            let client = try await ensureClientAndToken()
            let (videoData, videoURL) = try readLocalVideoData()
            processingOverlay = .generatingCaptions
            let result = try await client.generateCaptions(
                videoData: videoData,
                mimeType: Self.mimeType(for: videoURL),
                language: language
            )
            captionArtifacts.srt = result.srt
            captionArtifacts.vtt = result.vtt
            captionArtifacts.language = result.language
            noteEditSuccess()
            state = .ready
            processingOverlay = .editing
            messages.append(
                ChatMessage(
                    role: .assistant,
                    content: "Captions ready — soft SRT/VTT chips below.",
                    downloadChips: Self.sourceChips(srt: result.srt, vtt: result.vtt)
                )
            )
        } catch is CancellationError {
            // cancelled
        } catch let error as APIError {
            finishCaptionFailure(error)
        } catch {
            finishCaptionFailure(APIError.message(error.localizedDescription))
        }
    }

    private func runTranslateCaptions(targetLanguage: String) async {
        guard cloudProcessingEnabled else {
            state = localVideoURL == nil ? .empty : .ready
            return
        }
        do {
            guard let srt = captionArtifacts.srt, !srt.isEmpty else {
                state = .failed
                lastError = "Generate captions first"
                messages.append(
                    ChatMessage(
                        role: .assistant,
                        content: "Couldn't translate — generate captions first"
                    )
                )
                return
            }
            let client = try await ensureClientAndToken()
            processingOverlay = .translating
            let result = try await client.translateCaptions(
                srtContent: srt,
                targetLanguage: targetLanguage
            )
            captionArtifacts.translatedSrt = result.srt
            captionArtifacts.translatedVtt = result.vtt
            captionArtifacts.targetLanguage = result.targetLanguage
            noteEditSuccess()
            state = .ready
            processingOverlay = .editing

            var chips = Self.sourceChips(
                srt: captionArtifacts.srt ?? srt,
                vtt: captionArtifacts.vtt ?? ""
            )
            chips.append(contentsOf: Self.translationChips(
                srt: result.srt,
                vtt: result.vtt,
                language: result.targetLanguage
            ))
            messages.append(
                ChatMessage(
                    role: .assistant,
                    content: "Translated to \(result.targetLanguage) — source + target chips below.",
                    downloadChips: chips
                )
            )
        } catch is CancellationError {
            // cancelled
        } catch let error as APIError {
            finishCaptionFailure(error, fallback: "Couldn't translate captions — try again")
        } catch {
            finishCaptionFailure(APIError.message(error.localizedDescription), fallback: "Couldn't translate captions — try again")
        }
    }

    /// Sync burn-in via POST /api/process-video (never jobs).
    private func runBurnIn() async {
        guard cloudProcessingEnabled else {
            state = localVideoURL == nil ? .empty : .ready
            return
        }
        do {
            guard let srt = captionArtifacts.srt, !srt.isEmpty else {
                state = .failed
                lastError = "Generate captions first"
                messages.append(
                    ChatMessage(
                        role: .assistant,
                        content: "Couldn't burn captions — generate captions first"
                    )
                )
                return
            }
            let client = try await ensureClientAndToken()
            let (videoData, videoURL) = try readLocalVideoData()
            processingOverlay = .burningSubtitles
            let burned = try await client.burnSubtitles(
                videoData: videoData,
                fileName: videoURL.lastPathComponent,
                mimeType: Self.mimeType(for: videoURL),
                srtContent: srt,
                translatedSrtContent: captionArtifacts.translatedSrt
            )
            let out = FileManager.default.temporaryDirectory
                .appendingPathComponent("burned-\(UUID().uuidString).mp4")
            try burned.write(to: out)
            await rebaseStack(onto: out)
            noteEditSuccess()
            state = .ready
            processingOverlay = .editing

            var chips = Self.sourceChips(srt: srt, vtt: captionArtifacts.vtt ?? "")
            if let tSrt = captionArtifacts.translatedSrt, let tVtt = captionArtifacts.translatedVtt {
                chips.append(contentsOf: Self.translationChips(
                    srt: tSrt,
                    vtt: tVtt,
                    language: captionArtifacts.targetLanguage ?? "translated"
                ))
            }
            messages.append(
                ChatMessage(
                    role: .assistant,
                    content: captionArtifacts.hasTranslation
                        ? "Burned dual-language preview — soft chips still available."
                        : "Burned captions into preview — soft chips still available.",
                    downloadChips: chips
                )
            )
        } catch is CancellationError {
            // cancelled
        } catch let error as APIError {
            finishCaptionFailure(error, fallback: "Couldn't burn captions — try again")
        } catch {
            finishCaptionFailure(APIError.message(error.localizedDescription), fallback: "Couldn't burn captions — try again")
        }
    }

    /// Usage limit hit → keep the current clip, present the Paywall sheet (not the failed state).
    /// Returns true when the error was a paywall signal and has been handled.
    @discardableResult
    func handlePaywallIfNeeded(_ error: Error) -> Bool {
        guard let apiError = error as? APIError, apiError.isPaywall else { return false }
        processingOverlay = .editing
        activeJobId = nil
        lastError = nil
        state = localVideoURL == nil ? .empty : .ready
        messages.append(
            ChatMessage(
                role: .assistant,
                content: "You've used today's free edits — upgrade to keep editing."
            )
        )
        onPaywallRequired?()
        return true
    }

    private func finishCaptionFailure(_ error: APIError, fallback: String? = nil) {
        if handlePaywallIfNeeded(error) { return }
        noteEditError(kind: error.serverFailureKind)
        state = .failed
        processingOverlay = .editing
        let copy: String
        if case .noSpeechDetected = error {
            copy = error.captionsChatMessage
        } else if error.serverFailureKind == .photoUnsupported {
            copy = UXCopy.photoUnsupported
        } else if let fallback {
            copy = fallback
        } else {
            copy = error.captionsChatMessage
        }
        // Fixed copy only; never the server's or system's error text.
        lastError = copy
        messages.append(ChatMessage(role: .assistant, content: copy))
        // No fake VTT/SRT chips on failure.
    }

    static func sourceChips(srt: String, vtt: String) -> [CaptionDownloadChip] {
        var chips: [CaptionDownloadChip] = []
        if !srt.isEmpty {
            chips.append(CaptionDownloadChip(label: "SRT", filename: "captions.srt", content: srt))
        }
        if !vtt.isEmpty {
            chips.append(CaptionDownloadChip(label: "VTT", filename: "captions.vtt", content: vtt))
        }
        return chips
    }

    static func translationChips(srt: String, vtt: String, language: String) -> [CaptionDownloadChip] {
        let tag = language.prefix(2).uppercased()
        var chips: [CaptionDownloadChip] = []
        if !srt.isEmpty {
            chips.append(CaptionDownloadChip(label: "\(tag) SRT", filename: "captions-\(tag.lowercased()).srt", content: srt))
        }
        if !vtt.isEmpty {
            chips.append(CaptionDownloadChip(label: "\(tag) VTT", filename: "captions-\(tag.lowercased()).vtt", content: vtt))
        }
        return chips
    }

    // MARK: - Free-text edits → server chat tool calls (execution: "client")

    /// Hard local stop in addition to the server's `maxRounds` cap (6).
    static let maxClientRounds = 8

    /// Sends free text to `/api/chat` in client-execution mode. The model picks the tools
    /// and args; each tool call runs here (server jobs API for now) and its result is posted
    /// back until `status: "final"`. There is no local keyword fallback.
    func runChatTurn(prompt: String) async {
        guard let client = apiClient else {
            finishChatFailure(APIError.message("API client unavailable"))
            return
        }
        do {
            try await prepareAuth(client)
            var conversation: [JSONValue] = [ClientChat.userMessage(prompt)]
            var response = try await client.sendClientChat(
                ClientChatRequest(messages: conversation, media: await currentMedia(), thumbnails: await currentThumbnails())
            )
            var rounds = 0
            defer { currentTurnToken = nil }
            while response.status == "tool_calls", !response.toolCalls.isEmpty, rounds < Self.maxClientRounds {
                rounds += 1
                currentTurnToken = response.turnToken
                var results: [(callId: String, result: ClientToolResult)] = []
                for call in response.toolCalls {
                    if Task.isCancelled { return }
                    let result = await executeToolCall(call)
                    if Task.isCancelled { return }
                    results.append((call.id, result))
                    if importError != nil, localVideoURL == nil { break }
                }
                conversation = ClientChat.continuation(previous: conversation, response: response, results: results)
                if importError != nil, localVideoURL == nil {
                    // 415: the photo is gone from the editor; stop the loop at the import step.
                    finishTurn()
                    return
                }
                state = .processing
                processingOverlay = .editing
                response = try await client.sendClientChat(
                    ClientChatRequest(
                        messages: conversation,
                        media: await currentMedia(),
                        thumbnails: await currentThumbnails(),
                        turnToken: response.turnToken
                    )
                )
            }
            if let text = response.finalText?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
                messages.append(ChatMessage(role: .assistant, content: text))
            }
            finishTurn()
        } catch is CancellationError {
            // User sent another message or view torn down.
        } catch {
            if Task.isCancelled { return }
            finishChatFailure(error)
        }
    }

    // MARK: - Edit telemetry

    private func noteEditSuccess() {
        Telemetry.shared.track("edit_success")
    }

    /// Kind only — never the error's message text (may echo user content).
    private func noteEditError(kind: EditFailureKind) {
        Telemetry.shared.track("edit_error", props: ["kind": kind.rawValue])
    }

    /// Ends a turn and shows at most one end-of-turn card (generic → Retry; invalid
    /// arguments only when nothing succeeded). Photo-unsupported cards were already shown.
    private func finishTurn() {
        processingOverlay = .editing
        activeJobId = nil
        if let card = turnOutcome.endOfTurnCard(prompt: turnPrompt) {
            noteEditError(kind: card.kind)
            messages.append(.failure(card))
        } else {
            noteEditSuccess()
        }
        turnOutcome = EditTurnOutcome()
        if state == .processing || state == .failed {
            state = localVideoURL == nil ? .empty : .ready
        }
        isCloudStepRunning = false
    }

    /// The chat request itself failed. Copy comes from the stable code only.
    private func finishChatFailure(_ error: Error) {
        if handlePaywallIfNeeded(error) { return }
        processingOverlay = .editing
        activeJobId = nil
        let apiError = error as? APIError
        if case .clientModeUnavailable = apiError {
            // Keep the clip usable; this is not an edit failure.
            noteEditError(kind: .unavailable)
            state = localVideoURL == nil ? .empty : .ready
            messages.append(ChatMessage(role: .assistant, content: APIError.clientModeUnavailable.errorDescription ?? UXCopy.generic))
            return
        }
        let kind = apiError?.serverFailureKind ?? .generic
        if kind == .unsupportedImageFormat {
            noteEditError(kind: .unsupportedImageFormat)
            showUnsupportedImageFormat()
            return
        }
        state = localVideoURL == nil ? .empty : .ready
        lastError = nil
        let card = EditFailureCard(kind: kind, retryPrompt: kind.allowsRetry ? turnPrompt : nil)
        noteEditError(kind: card.kind)
        messages.append(.failure(card))
        turnOutcome = EditTurnOutcome()
    }

    private func prepareAuth(_ client: APIClient) async throws {
        if client.sampleModeEnabled {
            _ = try await client.ensureSampleAccessToken()
        } else {
            try? await client.ensureDeviceSession()
        }
    }

    /// Metadata for the model (`media` in the client-mode request). Never uploads the clip.
    func currentMedia() async -> ClientMedia? {
        guard let url = localVideoURL else { return nil }
        if let stack = await ensureStack() {
            // The edited clip, as the user sees it.
            let canvas = stack.canvas
            if canvas.isPhoto {
                return ClientMedia(type: "image", width: canvas.width, height: canvas.height)
            }
            let fps = try? await AVURLAsset(url: stack.base).loadTracks(withMediaType: .video).first?.load(.nominalFrameRate)
            return ClientMedia(
                type: "video",
                duration: stack.project?.durationSeconds ?? canvas.duration,
                width: stack.project?.canvas.width ?? canvas.width,
                height: stack.project?.canvas.height ?? canvas.height,
                fps: fps.flatMap { $0 > 0 ? Double($0) : nil },
                hasAudio: canvas.hasAudio,
                project: stack.project?.summary()
            )
        }
        if MediaMIME.isImage(url: url) {
            return ClientMedia(type: "image")
        }
        let asset = AVURLAsset(url: url)
        let duration = (try? await asset.load(.duration)).map { CMTimeGetSeconds($0) }
        var width: Int?
        var height: Int?
        var fps: Double?
        if let track = try? await asset.loadTracks(withMediaType: .video).first,
           let loaded = try? await track.load(.naturalSize, .preferredTransform, .nominalFrameRate) {
            let (size, transform, rate) = loaded
            let oriented = size.applying(transform)
            width = Int(abs(oriented.width).rounded())
            height = Int(abs(oriented.height).rounded())
            fps = rate > 0 ? Double(rate) : nil
        }
        let hasAudio = ((try? await asset.loadTracks(withMediaType: .audio)) ?? []).isEmpty == false
        return ClientMedia(
            type: "video",
            duration: duration.flatMap { $0.isFinite ? $0 : nil },
            width: width,
            height: height,
            fps: fps,
            hasAudio: hasAudio
        )
    }

    /// Executes one tool call (from the model or a chip). Missing required args are never
    /// sent to the server — they go back to the model as `ok: false`.
    func executeToolCall(_ call: ClientToolCall) async -> ClientToolResult {
        let tool = ToolCatalog.canonicalName(call.name)
        if call.argumentsError != nil {
            return record(.failure(ServerErrorCode.invalidArguments, on: .device), kind: .invalidArguments)
        }
        guard var stack = await ensureStack() else {
            return record(.failure("no_media", on: .device), kind: .generic)
        }
        // Multi-clip timeline tools dispatch to the shared ProjectCommand layer.
        if TimelineTools.names.contains(tool) {
            let result = await executeTimelineTool(call)
            return record(result, kind: result.ok ? nil : .generic)
        }
        // Legacy single-clip tools on a timeline project are translated onto it
        // (selected clip / canvas / one-clip disambiguation) when a translation exists.
        if stack.isTimelineProject, let translated = await executeLegacyToolOnProject(call) {
            return record(translated, kind: translated.ok ? nil : .generic)
        }
        switch NativeToolParser.plan(tool: tool, arguments: call.arguments, canvas: stack.canvas) {
        case .success(.query(let name)):
            return record(localQueryResult(name, media: await currentMedia()), kind: nil)
        case .success(.captions(let language, let burnIn)):
            return await runOnDeviceCaptions(call: call, stack: stack, language: language, burnIn: burnIn)
        case .success(.lyricCaptions(let request)):
            return await runLyricCaptions(call: call, stack: stack, request: request)
        case .success(.youtubeSoundtrack(let url, let startOffset, let originalVolume)):
            return await runYouTubeSoundtrack(call: call, url: url, startOffset: startOffset, originalVolume: originalVolume)
        case .success(.apply(let op)):
            stack.push(EditEntry(tool: tool, op: op, toolCallId: call.id))
            commitEdit(stack)
            await refreshPreview()
            messages.append(ChatMessage(role: .system, content: "\(Self.label(for: tool)) · \(UXCopy.onDevice)"))
            let canvas = stack.canvas
            var output: [String: JSONValue] = [
                "width": .number(Double(canvas.width)),
                "height": .number(Double(canvas.height)),
            ]
            if !canvas.isPhoto { output["duration"] = .number((canvas.duration * 1000).rounded() / 1000) }
            return record(.success(on: .device, output: output), kind: nil)
        case .failure(.unsupportedForPhoto):
            messages.append(.failure(EditFailureCard(kind: .photoUnsupported)))
            return record(.failure(ServerErrorCode.unsupportedForPhoto, on: .device), kind: .photoUnsupported)
        case .failure(.invalidArguments):
            return record(.failure(ServerErrorCode.invalidArguments, on: .device), kind: .invalidArguments)
        case .failure(.unsupportedOnDevice):
            guard cloudProcessingEnabled else {
                // Default: nothing is uploaded. Quiet card; the model explains in one line.
                messages.append(.failure(EditFailureCard(kind: .unavailable)))
                return record(.failure("unsupported_on_device", on: .device), kind: .unavailable)
            }
        }
        // Cloud processing is on and the tool has no native version: server path.
        let media = await currentMedia()
        let plan = ToolCatalog.plan(
            tool: tool,
            arguments: call.arguments,
            mediaDuration: media?.duration,
            isPhoto: isPhoto
        )
        switch plan {
        case .reject(let error):
            // Returned to the model; the user sees a card per the §8 rules, never this text.
            if error == ServerErrorCode.unsupportedForPhoto {
                messages.append(.failure(EditFailureCard(kind: .photoUnsupported)))
                return record(.failure(error, on: .device), kind: .photoUnsupported)
            }
            return record(.failure(error, on: .device), kind: .invalidArguments)
        case .localQuery(let name):
            return record(localQueryResult(name, media: media), kind: nil)
        case .captions(let language, let translateLanguage, let burnIn):
            let result = await runCaptionsTool(language: language, translateLanguage: translateLanguage, burnIn: burnIn)
            // Caption flows post their own fixed-copy chat message on failure.
            return record(result, kind: nil)
        case .serverJob(let operation, let args):
            return await runServerJob(tool: tool, operation: operation, args: args)
        case .ffmpegCli(let args):
            return await runFfmpegCliTool(call: call, arguments: args)
        }
    }

    /// `generate_captions` on the device: transcribe the edited clip's audio, offer SRT/VTT,
    /// and (by default) burn the captions into preview and export as an undoable edit.
    private func runOnDeviceCaptions(call: ClientToolCall, stack: EditStack, language: String?, burnIn: Bool) async -> ClientToolResult {
        processingOverlay = .generatingCaptions
        defer { processingOverlay = .editing }
        let composed: ComposedVideo
        if let current = composedVideo, editStack == stack {
            composed = current
        } else {
            guard let fresh = try? await NativeComposer.compose(stack) else {
                return record(.failure("captions_failed", on: .device), kind: .generic)
            }
            composed = fresh
        }
        let transcript: CaptionTranscript
        do {
            transcript = try await captioner.transcribe(composed, language: language)
        } catch OnDeviceCaptioner.Failure.notAuthorized {
            messages.append(ChatMessage(role: .system, content: UXCopy.captionsPermission))
            return record(.failure("speech_permission_denied", on: .device), kind: nil)
        } catch OnDeviceCaptioner.Failure.unavailable {
            messages.append(.failure(EditFailureCard(kind: .unavailable)))
            return record(.failure("unsupported_on_device", on: .device), kind: .unavailable)
        } catch {
            return record(.failure("captions_failed", on: .device), kind: .generic)
        }
        let cues = CaptionFormatter.cues(from: transcript.words)
        guard !cues.isEmpty else {
            messages.append(ChatMessage(role: .system, content: UXCopy.captionsNoSpeech))
            return record(.failure("no_speech", on: .device), kind: nil)
        }
        let srt = CaptionFormatter.srt(cues)
        let vtt = CaptionFormatter.vtt(cues)
        captionArtifacts = CaptionArtifacts(srt: srt, vtt: vtt, language: transcript.language)
        if burnIn, var current = editStack {
            current.push(EditEntry(tool: "generate_captions", op: .captions(cues), toolCallId: call.id))
            commitEdit(current)
            await refreshPreview()
        }
        messages.append(ChatMessage(
            role: .system,
            content: "\(UXCopy.captionsOnDevice) · \(UXCopy.onDevice)",
            downloadChips: Self.sourceChips(srt: srt, vtt: vtt)
        ))
        let text = cues.map(\.text).joined(separator: " ")
        return record(.success(on: .device, output: [
            "cues": .number(Double(cues.count)),
            "language": .string(transcript.language),
            "burnedIn": .bool(burnIn),
            "text": .string(String(text.prefix(600))),
        ]), kind: nil)
    }

    // MARK: - Confirmation prompts

    /// Shows a two-button prompt and waits for the answer (true = primary button).
    func confirm(_ prompt: CloudPrompt) async -> Bool {
        if let promptHandler { return await promptHandler(prompt) }
        promptContinuation?.resume(returning: false)
        promptContinuation = nil
        return await withCheckedContinuation { continuation in
            promptContinuation = continuation
            pendingPrompt = prompt
        }
    }

    func resolvePrompt(primary: Bool) {
        let continuation = promptContinuation
        promptContinuation = nil
        pendingPrompt = nil
        continuation?.resume(returning: primary)
    }

    // MARK: - lyric_captions (streamed transcription + translation, audio only)

    /// `lyric_captions`: the audio is decoded on the device and streamed to ElevenLabs (never the
    /// video), the text goes to FinalCap to be translated, and the timed lines become an undoable
    /// overlay burned in on preview and export. Not gated by Cloud processing.
    private func runLyricCaptions(call: ClientToolCall, stack: EditStack, request: LyricCaptionRequest) async -> ClientToolResult {
        func fail(_ code: String, copy: String? = nil) -> ClientToolResult {
            if let copy { messages.append(ChatMessage(role: .assistant, content: copy)) }
            return record(.failure(code, on: .device), kind: nil)
        }
        if stack.canvas.duration > StreamingConstants.maxAudioSeconds {
            return fail("audio_too_long", copy: LyricCaptionsCopy.tooLong)
        }
        // No Cloud-processing gate and no consent dialog: this runs whatever the setting. A short,
        // non-blocking note says what is sent (the audio, not the video).
        messages.append(ChatMessage(role: .system, content: LyricCaptionsCopy.audioNote(target: LyricCaptionsCopy.targetName(request.targetLanguage))))
        guard let client = apiClient else { return fail("lyric_captions_failed", copy: LyricCaptionsCopy.generic) }

        state = .processing
        isCloudStepRunning = true
        lyricStatus = StreamingPercent.text(stage: .connecting, percent: nil)
        UIApplication.shared.isIdleTimerDisabled = true
        defer {
            UIApplication.shared.isIdleTimerDisabled = false
            isCloudStepRunning = false
            lyricStatus = nil
            activeJobId = nil
        }
        let composed: ComposedVideo
        if let current = composedVideo, editStack == stack {
            composed = current
        } else {
            guard let fresh = try? await NativeComposer.compose(stack) else {
                return fail("lyric_captions_failed", copy: LyricCaptionsCopy.generic)
            }
            composed = fresh
        }
        let pcm: [Int16]
        do {
            pcm = try await CaptionAudioDecoder.pcm16kMono(composed)
        } catch CaptionAudioDecoder.DecodeError.noAudio {
            return fail("no_audio", copy: LyricCaptionsCopy.noAudio)
        } catch {
            return fail("lyric_captions_failed", copy: LyricCaptionsCopy.generic)
        }
        if Task.isCancelled { return .failure("cancelled", on: .server) }

        let turnToken = currentTurnToken
        var deps = StreamingDeps(
            mint: { source, resume in
                do {
                    try await self.prepareAuth(client)
                    return try await client.mintStreamingCaptionsToken(sourceLanguage: source, resumeSessionId: resume, turnToken: turnToken, toolCallId: call.id)
                } catch {
                    throw APIClient.streamingError(from: error)
                }
            },
            translate: { batch in
                do {
                    return try await client.translateStreamingCaptions(batch, turnToken: turnToken, toolCallId: call.id)
                } catch is CancellationError {
                    throw CancellationError()
                } catch let error as URLError where error.code == .cancelled {
                    throw CancellationError()
                } catch {
                    throw APIClient.streamingError(from: error)
                }
            },
            makeSocket: captionSocketFactory
        )
        deps.confirmContinue = { [weak self] atSec, reason in
            guard let self else { return false }
            let message = reason == "time_limit" ? StreamingCopy.timeLimit(at: atSec) : StreamingCopy.connectionDropped(at: atSec)
            return await self.confirm(LyricCaptionsCopy.continuePrompt(message: message))
        }
        deps.onProgress = { [weak self] progress in
            // Monotonic and never above 99: 100 is only shown once the overlay is ready.
            self?.lyricStatus = progress.text
        }
        streamingDepsTweak?(&deps)

        do {
            let engine = StreamingCaptionsEngine(deps: deps)
            let result = try await engine.run(pcm: pcm, targetLanguage: request.targetLanguage, sourceLanguage: request.sourceLanguage)
            let lines = result.lines
                .map { LyricLine(start: $0.start, end: $0.end, text: $0.text, translation: $0.translation) }
                .filter { $0.start.isFinite && $0.end.isFinite && $0.end > $0.start && !$0.displayText.isEmpty }
            guard !lines.isEmpty else { return lyricFailure(StreamingError(code: "no_speech")) }

            lyricStatus = LyricCaptionsCopy.addingCaptions
            let track = LyricCaptionTrack(
                lines: lines,
                positionFromBottomPct: request.positionFromBottomPct ?? LyricCaptionStyle.defaultPositionPct,
                fontSize: request.fontSize
            )
            guard var current = editStack else { return fail("no_media") }
            current.push(EditEntry(tool: "lyric_captions", op: .lyricCaptions(track), toolCallId: call.id, executedOn: .server))
            commitEdit(current)
            await refreshPreview()
            let canvas = composed.renderSize
            messages.append(ChatMessage(
                role: .system,
                content: LyricCaptionsCopy.appliedLabel(song: nil, language: result.language, targetLanguage: request.targetLanguage)
            ))
            // Short result for the model: never the caption text.
            var output: [String: JSONValue] = [
                "lineCount": .number(Double(lines.count)),
                "targetLanguage": .string(request.targetLanguage),
                "mode": .string("speech"),
                "burnedIn": .bool(true),
                "width": .number(Double(canvas.width.rounded())),
                "height": .number(Double(canvas.height.rounded())),
                "duration": .number((composed.duration * 1000).rounded() / 1000),
            ]
            if let language = result.language { output["language"] = .string(language) }
            return record(.success(on: .server, output: output), kind: nil)
        } catch is CancellationError {
            return .failure("cancelled", on: .server)
        } catch {
            let streaming = APIClient.streamingError(from: error)
            if streaming.code == "paywall" {
                handlePaywallIfNeeded(APIError.paywallRequired(nil))
                return record(.failure("paywall", on: .server), kind: nil)
            }
            return lyricFailure(streaming)
        }
    }

    /// Friendly chat card for a streaming-captions error; nothing was applied.
    private func lyricFailure(_ error: StreamingError) -> ClientToolResult {
        messages.append(ChatMessage(role: .assistant, content: StreamingCopy.friendly(error)))
        let known: Set<String> = ["no_speech", "audio_too_long", "no_audio", "streaming_captions_unavailable", "streaming_captions_busy"]
        let stable: String
        switch error.code {
        case _ where known.contains(error.code): stable = error.code
        case "unavailable": stable = "streaming_captions_unavailable"
        case "busy", "rate_limited": stable = "streaming_captions_busy"
        default: stable = error.status == 503 ? "streaming_captions_unavailable" : "lyric_captions_failed"
        }
        return record(.failure(stable, on: .server), kind: nil)
    }

    @discardableResult
    private func record(_ result: ClientToolResult, kind: EditFailureKind?) -> ClientToolResult {
        turnOutcome.record(result, kind: kind)
        return result
    }

    /// Applies the §8 UI for a failed server step and returns the model-facing result.
    private func serverFailure(_ kind: EditFailureKind) -> ClientToolResult {
        switch kind {
        case .photoUnsupported:
            messages.append(.failure(EditFailureCard(kind: .photoUnsupported)))
        case .unsupportedImageFormat:
            showUnsupportedImageFormat()
        case .invalidArguments, .generic, .unavailable:
            break // end-of-turn card
        }
        return record(.failure(kind.toolError, on: .server), kind: kind)
    }

    private func localQueryResult(_ tool: String, media: ClientMedia?) -> ClientToolResult {
        switch tool {
        case "get_video_dimensions":
            guard let media else { return .failure("no_media", on: .device) }
            var output: [String: JSONValue] = ["type": .string(media.type)]
            if let w = media.width { output["width"] = .number(Double(w)) }
            if let h = media.height { output["height"] = .number(Double(h)) }
            if let d = media.duration { output["duration"] = .number(d) }
            if let f = media.fps { output["fps"] = .number(f) }
            if let a = media.hasAudio { output["hasAudio"] = .bool(a) }
            return .success(on: .device, output: output)
        default:
            return .success(on: .device, output: [
                "video": .array(["mp4", "mov"].map { .string($0) }),
                "image": .array(["jpg", "png", "heic"].map { .string($0) }),
            ])
        }
    }

    /// Short human label for an edit card.
    static func label(for tool: String) -> String {
        let names: [String: String] = [
            "trim_video": "Trim", "adjust_speed": "Speed", "crop_video": "Crop", "rotate_video": "Rotate",
            "flip_video_horizontal": "Flip", "flip_video_vertical": "Flip vertical", "resize_video": "Resize",
            "resize_video_preset": "Aspect ratio", "adjust_brightness": "Brightness", "adjust_contrast": "Contrast",
            "adjust_saturation": "Saturation", "adjust_hue": "Hue", "apply_color_filter": "Color filter",
            "add_text": "Text", "adjust_audio_volume": "Volume", "audio_fade": "Fade",
            "youtube_soundtrack": "Soundtrack",
            "convert_video_format": "Format", "convert_image_format": "Format",
        ]
        return names[tool] ?? tool.replacingOccurrences(of: "_", with: " ").capitalized
    }

    /// Up to 4 small JPEG frames of the edited clip for the model (never the video).
    func currentThumbnails() async -> [String]? {
        guard let stack = editStack else { return nil }
        if stack.isPhoto {
            guard let image = previewPhoto, let data = Self.thumbnailJPEG(image) else { return nil }
            return [data.base64EncodedString()]
        }
        guard let composed = composedVideo, composed.duration > 0 else { return nil }
        let generator = composed.makeImageGenerator(maxSize: CGSize(width: 512, height: 512))
        generator.requestedTimeToleranceBefore = CMTime(seconds: 0.5, preferredTimescale: 600)
        generator.requestedTimeToleranceAfter = CMTime(seconds: 0.5, preferredTimescale: 600)
        var frames: [String] = []
        for i in 0..<4 {
            let t = CMTime(seconds: composed.duration * (Double(i) + 0.5) / 4, preferredTimescale: 600)
            if let cg = try? await generator.image(at: t).image,
               let data = Self.thumbnailJPEG(UIImage(cgImage: cg)) {
                frames.append(data.base64EncodedString())
            }
        }
        return frames.isEmpty ? nil : frames
    }

    /// JPEG ≤ 300 KB (server limit), longest side ≤ 512.
    static func thumbnailJPEG(_ image: UIImage) -> Data? {
        let longest = max(image.size.width, image.size.height)
        let scale = longest > 512 ? 512 / longest : 1
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let small = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        for quality in [0.6, 0.4, 0.25] {
            if let data = small.jpegData(compressionQuality: quality), data.count <= 300_000 { return data }
        }
        return nil
    }

    private func runCaptionsTool(language: String, translateLanguage: String?, burnIn: Bool) async -> ClientToolResult {
        guard await confirmServerCaptionsUpload() else {
            return .failure(cloudProcessingEnabled ? "skipped_by_user" : "unsupported_on_device", on: .device)
        }
        // Captions time against the edited clip: bake device edits in before uploading.
        if let stack = editStack, !stack.entries.isEmpty {
            isCloudStepRunning = true
            let flat = await flattenedMediaURL()
            isCloudStepRunning = false
            guard let flat else { return record(.failure("render_failed", on: .device), kind: .generic) }
            await rebaseStack(onto: flat)
        }
        processingOverlay = .generatingCaptions
        await runGenerateCaptions(language: language, confirmed: true)
        guard captionArtifacts.hasSource else {
            return .failure("captions_failed", on: .server)
        }
        if let translateLanguage {
            state = .processing
            await runTranslateCaptions(targetLanguage: translateLanguage)
            guard captionArtifacts.hasTranslation else {
                return .failure("translation_failed", on: .server)
            }
        }
        if burnIn {
            state = .processing
            let before = localVideoURL
            await runBurnIn()
            if state == .failed || localVideoURL == before {
                return .failure("burn_in_failed", on: .server)
            }
        }
        state = .processing
        return .success(on: .server)
    }

    /// Runs one operation on the async jobs API, then swaps the preview to the result.
    /// The upload carries the file's real MIME type; the result keeps the server's type.
    private func runServerJob(tool: String, operation: String, args: [String: JSONValue]) async -> ClientToolResult {
        guard let client = apiClient, localVideoURL != nil else {
            return record(.failure("no_media", on: .server), kind: .generic)
        }
        // Cloud steps bake the device edits in first (Design §3 "flatten"); the result becomes
        // the stack's new base and the pre-cloud state stays undoable.
        state = .processing
        isCloudStepRunning = true
        defer { isCloudStepRunning = false }
        guard let mediaURL = await flattenedMediaURL() else {
            return record(.failure("render_failed", on: .device), kind: .generic)
        }
        // Photos upload as JPEG/PNG only — never HEIC (prod FFmpeg has no HEIF decoder).
        let uploadURL: URL
        if MediaMIME.isImage(url: mediaURL) {
            guard let safe = try? PhotoTranscoder.uploadablePhoto(at: mediaURL) else {
                return serverFailure(.unsupportedImageFormat)
            }
            uploadURL = safe
        } else {
            uploadURL = mediaURL
        }
        do {
            try await prepareAuth(client)
            // Cloud processing is on (this path is unreachable with it off).
            state = .uploading
            processingOverlay = .editing
            let uploadData = try Data(contentsOf: uploadURL)
            let enqueue = try await client.submitProcessVideoJob(
                videoData: uploadData,
                fileName: uploadURL.lastPathComponent,
                mimeType: MediaMIME.mimeType(for: uploadURL),
                operation: operation,
                args: args.mapValues { $0.foundationValue }
            )
            activeJobId = enqueue.jobId
            state = .processing
            let final = try await client.pollJob(id: enqueue.jobId)
            activeJobId = nil
            guard final.status == .succeeded else {
                // Failed polls carry the stable `code` (Backend #88); `error` text is ignored.
                return serverFailure(EditFailureKind.from(code: final.code))
            }
            let download = try await client.downloadJobResultWithContentType(
                id: enqueue.jobId,
                resultUrl: final.resultUrl
            )
            let ext = MediaMIME.fileExtension(
                forContentType: final.contentType ?? download.contentType,
                mediaType: final.mediaType
            )
            let out = FileManager.default.temporaryDirectory
                .appendingPathComponent("\(enqueue.jobId).\(ext)")
            try download.data.write(to: out)
            await rebaseStack(onto: out)
            messages.append(ChatMessage(role: .system, content: "\(Self.label(for: tool)) · \(UXCopy.cloud)"))
            return record(.success(on: .server), kind: nil)
        } catch is CancellationError {
            activeJobId = nil
            return .failure("cancelled", on: .server)
        } catch {
            activeJobId = nil
            if let apiError = error as? APIError, apiError.isPaywall {
                handlePaywallIfNeeded(apiError)
                return .failure("paywall", on: .server)
            }
            // Sync error bodies (submit 400/415) carry the same stable codes.
            return serverFailure((error as? APIError)?.serverFailureKind ?? .generic)
        }
    }

    /// Server-side FFmpeg fallback for `ffmpeg_cli` tool calls: no on-device (AVFoundation)
    /// tool can handle the request, so it runs on the server instead.
    /// - `discover` / `plan` are JSON-only (no upload); the result goes back to the model.
    /// - `run` uploads the flattened current video to POST /api/ffmpeg-cli/run and the
    ///   processed bytes download back, rebased onto the edit stack as the new base —
    ///   seamless for the user (previous state stays undoable).
    private func runFfmpegCliTool(call: ClientToolCall, arguments: [String: JSONValue]) async -> ClientToolResult {
        guard let client = apiClient else {
            return record(.failure("no_media", on: .server), kind: .generic)
        }
        let action = arguments["action"]?.stringValue ?? ""
        var params = arguments.mapValues { $0.foundationValue }
        params.removeValue(forKey: "action")
        do {
            try await prepareAuth(client)
        } catch {
            return record(.failure("auth_failed", on: .server), kind: .generic)
        }
        switch action {
        case "discover", "plan":
            do {
                let data = try await client.ffmpegCliJSON(action: action, params: params)
                let text = String(data: data, encoding: .utf8) ?? "{}"
                return record(.success(on: .server, output: ["result": .string(text)]), kind: nil)
            } catch {
                return serverFailure((error as? APIError)?.serverFailureKind ?? .generic)
            }
        case "run":
            break
        default:
            return record(.failure(ServerErrorCode.invalidArguments, on: .device), kind: .invalidArguments)
        }
        guard localVideoURL != nil else {
            return record(.failure("no_media", on: .server), kind: .generic)
        }
        // Cloud steps bake the device edits in first (Design §3 "flatten"); the result becomes
        // the stack's new base and the pre-cloud state stays undoable.
        state = .processing
        isCloudStepRunning = true
        defer { isCloudStepRunning = false }
        guard let mediaURL = await flattenedMediaURL() else {
            return record(.failure("render_failed", on: .device), kind: .generic)
        }
        do {
            // Cloud processing is on (this path is unreachable with it off).
            state = .uploading
            processingOverlay = .editing
            let uploadData = try Data(contentsOf: mediaURL)
            state = .processing
            let result = try await client.runFfmpegCli(
                videoData: uploadData,
                fileName: mediaURL.lastPathComponent,
                mimeType: MediaMIME.mimeType(for: mediaURL),
                args: params
            )
            let ext = Self.ffmpegCliOutputExtension(for: result.outputFormat)
            let out = FileManager.default.temporaryDirectory
                .appendingPathComponent("ffmpeg-cli-\(call.id).\(ext)")
            try result.data.write(to: out)
            await rebaseStack(onto: out)
            let detail = result.explanation.isEmpty ? "Processed with FFmpeg" : result.explanation
            messages.append(ChatMessage(role: .system, content: "\(detail) · \(UXCopy.cloud)"))
            return record(.success(on: .server, output: [
                "outputFormat": .string(result.outputFormat),
                "command": .string(result.command),
                "explanation": .string(result.explanation),
            ]), kind: nil)
        } catch is CancellationError {
            return .failure("cancelled", on: .server)
        } catch {
            if let apiError = error as? APIError, apiError.isPaywall {
                handlePaywallIfNeeded(apiError)
                return .failure("paywall", on: .server)
            }
            // Sync error bodies (400 validation errors) carry the same stable codes.
            return serverFailure((error as? APIError)?.serverFailureKind ?? .generic)
        }
    }

    // MARK: - youtube_soundtrack (server-fetched audio, on-device mix)

    /// `youtube_soundtrack`: sends ONLY the pasted link to `POST /api/youtube-audio/fetch`,
    /// saves the returned AAC in the app's cache, and pushes an undoable `.soundtrack`
    /// edit — the composer plays the song from `startOffset`, trimmed to the video's
    /// length, with the original audio scaled to `originalVolume`. Requires Cloud
    /// processing: with it off, the muted `unsupported_on_device` card shows and
    /// nothing is fetched (docs/ios/native-tools.md §5c).
    private func runYouTubeSoundtrack(call: ClientToolCall, url: String, startOffset: Double, originalVolume: Double) async -> ClientToolResult {
        guard cloudProcessingEnabled else {
            messages.append(.failure(EditFailureCard(kind: .unavailable)))
            return record(.failure("unsupported_on_device", on: .device), kind: .unavailable)
        }
        guard let client = apiClient else {
            return record(.failure("no_media", on: .server), kind: .generic)
        }
        do {
            try await prepareAuth(client)
        } catch {
            return record(.failure("auth_failed", on: .server), kind: .generic)
        }
        state = .processing
        isCloudStepRunning = true
        processingOverlay = .editing
        defer { isCloudStepRunning = false }
        let fetched: APIClient.YouTubeAudioResult
        do {
            fetched = try await client.fetchYouTubeAudio(url: url)
        } catch is CancellationError {
            return .failure("cancelled", on: .server)
        } catch {
            if let apiError = error as? APIError, apiError.isPaywall {
                handlePaywallIfNeeded(apiError)
                return .failure("paywall", on: .server)
            }
            // The endpoint's stable codes (youtube_audio_too_long, invalid_youtube_url,
            // youtube_fetch_failed, …) ride back to the model so it can react; the
            // failure card follows the §8 rules via the recorded kind.
            if let apiError = error as? APIError, let code = apiError.serverCode {
                return record(.failure(code, on: .server), kind: apiError.serverFailureKind)
            }
            return serverFailure((error as? APIError)?.serverFailureKind ?? .generic)
        }
        // Same check the web tool makes: the offset must land inside the song.
        if let duration = fetched.duration, duration > 0, startOffset >= duration {
            return record(.failure(ServerErrorCode.invalidArguments, on: .device), kind: .invalidArguments)
        }
        let file: URL
        do {
            file = try Self.storeSoundtrack(data: fetched.data, videoId: fetched.videoId)
        } catch {
            return record(.failure("youtube_fetch_failed", on: .device), kind: .generic)
        }
        guard var current = editStack else {
            return record(.failure("no_media", on: .device), kind: .generic)
        }
        if current.project != nil {
            // Timeline mode: the song becomes a normal audio clip on a Soundtrack
            // lane (movable/trimmable/removable like any other audio clip).
            guard await insertSoundtrackIntoTimeline(file: file, startOffset: startOffset, originalVolume: originalVolume) else {
                return record(.failure("youtube_fetch_failed", on: .device), kind: .generic)
            }
            state = .ready
            messages.append(ChatMessage(role: .system, content: "\(Self.label(for: "youtube_soundtrack")) · \(UXCopy.cloud)"))
            let project = timelineProject
            var output: [String: JSONValue] = [
                "duration": .number(((project?.durationSeconds ?? 0) * 1000).rounded() / 1000),
            ]
            if let title = fetched.title, !title.isEmpty { output["title"] = .string(title) }
            if let duration = fetched.duration { output["audioDuration"] = .number(duration) }
            return record(.success(on: .server, output: output), kind: nil)
        }
        current.push(EditEntry(
            tool: "youtube_soundtrack",
            op: .soundtrack(file: file, startOffset: startOffset, originalVolume: originalVolume),
            toolCallId: call.id,
            executedOn: .server
        ))
        commitEdit(current)
        await refreshPreview()
        messages.append(ChatMessage(role: .system, content: "\(Self.label(for: "youtube_soundtrack")) · \(UXCopy.cloud)"))
        let canvas = current.canvas
        var output: [String: JSONValue] = [
            "width": .number(Double(canvas.width)),
            "height": .number(Double(canvas.height)),
            "duration": .number((canvas.duration * 1000).rounded() / 1000),
        ]
        if let title = fetched.title, !title.isEmpty { output["title"] = .string(title) }
        if let duration = fetched.duration { output["audioDuration"] = .number(duration) }
        return record(.success(on: .server, output: output), kind: nil)
    }

    /// Saves a fetched soundtrack in the Caches directory, named by YouTube video id
    /// when the server sent one (repeat fetches of a song reuse the same file).
    private static func storeSoundtrack(data: Data, videoId: String?) throws -> URL {
        let caches = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let dir = caches.appendingPathComponent("soundtracks", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let safeId = (videoId ?? "").filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
        let file = dir.appendingPathComponent("\(safeId.isEmpty ? UUID().uuidString : safeId).m4a")
        try data.write(to: file, options: .atomic)
        return file
    }

    /// Safe file extension for an ffmpeg_cli output format (server allowlist mirror).
    private static func ffmpegCliOutputExtension(for format: String) -> String {
        let known: Set<String> = ["mp4", "mov", "webm", "mkv", "gif", "mp3", "wav", "m4a", "aac", "ogg", "flac", "jpg", "png"]
        let lower = format.lowercased()
        return known.contains(lower) ? lower : "mp4"
    }

    /// The file a cloud step should upload: the base when there are no device edits, else a
    /// rendered copy of the current stack.
    private func flattenedMediaURL() async -> URL? {
        guard let url = localVideoURL else { return nil }
        guard let stack = await ensureStack(), !stack.entries.isEmpty else { return url }
        if stack.isPhoto {
            return await Task.detached(priority: .userInitiated) { try? PhotoRenderer.exportFile(stack) }.value
        }
        guard let composed = try? await NativeComposer.compose(stack) else { return nil }
        return try? await NativeExporter().export(composed, format: stack.outputFormat, progress: { _ in })
    }

    /// Cloud result → new stack base (previous state kept for Undo).
    func rebaseStack(onto url: URL) async {
        let canvas = await Self.loadCanvas(url)
        if var stack = editStack, let canvas {
            if stack.entries.isEmpty == false || stack.base != url {
                stack.rebase(onto: url, canvas: canvas)
                editStack = stack
                registerUndo(redo: false)
            } else {
                editStack = stack
            }
            localVideoURL = url
            await refreshPreview()
        } else {
            localVideoURL = url
            startEditing(url)
        }
    }

    nonisolated static func mimeType(for url: URL) -> String {
        MediaMIME.mimeType(for: url)
    }

    private var bundledTestVideoURL: URL? {
        Bundle.main.url(forResource: "sample-lake", withExtension: "mp4")
            ?? Bundle.main.url(forResource: "finalcap-test-video", withExtension: "mp4")
    }

    private var canAutoLoadBundledTestVideo: Bool {
        guard localVideoURL == nil else { return false }
        guard state == .empty, activeJobId == nil, captionArtifacts == CaptionArtifacts() else { return false }
        guard composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return messages.isEmpty
    }

    private var shouldResetBundledTestVideo: Bool {
        guard isBundledTestVideoLoaded else { return false }
        guard state == .ready, activeJobId == nil, captionArtifacts == CaptionArtifacts() else { return false }
        guard composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return messages.isEmpty || (
            messages.count == 1 &&
            messages[0].role == .system &&
            messages[0].content == "Loaded test video"
        )
    }

    private var isBundledTestVideoLoaded: Bool {
        guard let localVideoURL else { return false }
        return localVideoURL.standardizedFileURL == bundledTestVideoURL?.standardizedFileURL
    }
}

#Preview {
    EditorView()
        .environmentObject(AppModel())
}
