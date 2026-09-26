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
    @StateObject private var dictation = DictationController()
    /// Observed so chips and routing refresh when Settings → Cloud processing changes.
    @AppStorage(NativeSettings.cloudProcessingKey) private var cloudProcessing = false

    var body: some View {
        VStack(spacing: 0) {
            TopBarView(
                photosPickerItem: $model.photosPickerItem,
                onExport: { showExport = true },
                onUpgrade: { appModel.presentPaywall(reason: .upgradeTapped) },
                importEnabled: importEnabled,
                exportVisible: model.localVideoURL != nil,
                exportEnabled: model.state != .processing && model.state != .uploading,
                showUpgrade: !appModel.hasSubscription,
                freeRemaining: TopBarView.visibleFreeRemaining(unlimited: appModel.isUnlimited, remaining: appModel.dailyRemaining),
                onSettings: { showSettings = true }
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
                    processingMessage: model.processingOverlay.message,
                    playerItem: model.previewItem,
                    photo: model.previewPhoto,
                    showsDimmer: model.isCloudStepRunning,
                    canUndo: model.editStack?.canUndo == true && !model.isBusy,
                    onUndo: { model.undoLastEdit() }
                )
                .frame(maxHeight: 240)
                if let importError = model.importError {
                    ImportErrorBanner(message: importError, photosPickerItem: $model.photosPickerItem)
                }
            }

            Divider().overlay(AppTheme.border)

            ChatView(
                messages: model.messages,
                onRetry: { model.retry($0) },
                queuedIDs: Set(model.queuedPromptIDs),
                isWorking: model.isBusy
            )
                .frame(maxHeight: .infinity)

            if model.showSampleChips && model.localVideoURL != nil {
                SampleChipsView(chips: model.sampleChips) { chip in
                    model.applySampleChip(chip)
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
        .accessibilityIdentifier("Editor")
        .sheet(isPresented: $showExport) {
            ExportSheet(videoURL: model.localVideoURL, state: model.state, stack: model.editStack)
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
        .sheet(isPresented: $appModel.isPaywallPresented) {
            PaywallView()
                .environmentObject(appModel)
        }
        .onChange(of: model.photosPickerItem) { _, item in
            Task { await model.loadPhotosPickerItem(item) }
        }
        .onAppear {
            model.apiClient = appModel.apiClient
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
        model.state != .uploading && model.state != .processing
    }

    /// Launch / empty state shows the import panel in place of the preview.
    private var showsImportPanel: Bool {
        model.localVideoURL == nil && (model.state == .empty || model.state == .failed)
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
    @Published var showSampleChips = true
    @Published var lastError: String?
    @Published var activeJobId: String?
    @Published var processingOverlay: ProcessingOverlayKind = .editing
    @Published var captionArtifacts = CaptionArtifacts()
    /// Import-step error (`import.failed.format`); never an edit card.
    @Published var importError: String?

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
    /// Server reported the free usage limit (402 `paywall` / 429 `daily_limit_reached`).
    var onPaywallRequired: (() -> Void)?
    /// An inference request completed (success or failure) — refresh quota display.
    var onInferenceFinished: (() -> Void)?

    /// Sample chips (photo-safe set for photos). Each maps to a correct tool with complete args.
    var sampleChips: [String] { EditorRoute.chips(isPhoto: isPhoto, cloud: cloudProcessingEnabled) }

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
            state = .uploading
            lastError = nil
            do {
                let video = try await Task.detached {
                    try ImportedVideo.copy(from: url)
                }.value
                finishImport(video, message: "Imported \(video.url.lastPathComponent)")
            } catch {
                failImport(isPhoto: MediaMIME.isImage(url: url) || error is PhotoTranscoder.TranscodeError)
            }
        case .failure:
            failImport(isPhoto: false)
        }
    }

    func loadPhotosPickerItem(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        state = .uploading
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
        } else {
            guard let composed = try? await NativeComposer.compose(stack) else { return }
            guard generation == previewGeneration else { return }
            composedVideo = composed
            previewItem = composed.makePlayerItem()
            previewPhoto = nil
        }
    }

    /// Undo the last edit (Design §3). Never touches the base file.
    func undoLastEdit() {
        guard var stack = editStack, stack.undo() else { return }
        editStack = stack
        localVideoURL = stack.base
        Task { await refreshPreview() }
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
        guard state != .processing, state != .uploading else { return }
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
        guard state != .processing, state != .uploading else { return }
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
    var isBusy: Bool { state == .processing || state == .uploading }

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

    private func runGenerateCaptions(language: String = "auto") async {
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
            while response.status == "tool_calls", !response.toolCalls.isEmpty, rounds < Self.maxClientRounds {
                rounds += 1
                var results: [(callId: String, result: ClientToolResult)] = []
                for call in response.toolCalls {
                    if Task.isCancelled { return }
                    let result = await executeToolCall(call)
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
                    ClientChatRequest(messages: conversation, media: await currentMedia(), thumbnails: await currentThumbnails())
                )
            }
            if let text = response.finalText?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
                messages.append(ChatMessage(role: .assistant, content: text))
            }
            finishTurn()
        } catch is CancellationError {
            // User sent another message or view torn down.
        } catch {
            finishChatFailure(error)
        }
    }

    /// Ends a turn and shows at most one end-of-turn card (generic → Retry; invalid
    /// arguments only when nothing succeeded). Photo-unsupported cards were already shown.
    private func finishTurn() {
        processingOverlay = .editing
        activeJobId = nil
        if let card = turnOutcome.endOfTurnCard(prompt: turnPrompt) {
            messages.append(.failure(card))
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
            state = localVideoURL == nil ? .empty : .ready
            messages.append(ChatMessage(role: .assistant, content: APIError.clientModeUnavailable.errorDescription ?? UXCopy.generic))
            return
        }
        let kind = apiError?.serverFailureKind ?? .generic
        if kind == .unsupportedImageFormat {
            showUnsupportedImageFormat()
            return
        }
        state = localVideoURL == nil ? .empty : .ready
        lastError = nil
        let card = EditFailureCard(kind: kind, retryPrompt: kind.allowsRetry ? turnPrompt : nil)
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
                duration: canvas.duration,
                width: canvas.width,
                height: canvas.height,
                fps: fps.flatMap { $0 > 0 ? Double($0) : nil },
                hasAudio: canvas.hasAudio
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
        switch NativeToolParser.plan(tool: tool, arguments: call.arguments, canvas: stack.canvas) {
        case .success(.query(let name)):
            return record(localQueryResult(name, media: await currentMedia()), kind: nil)
        case .success(.apply(let op)):
            stack.push(EditEntry(tool: tool, op: op, toolCallId: call.id))
            editStack = stack
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
        }
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
        // Captions time against the edited clip: bake device edits in before uploading.
        if let stack = editStack, !stack.entries.isEmpty {
            isCloudStepRunning = true
            let flat = await flattenedMediaURL()
            isCloudStepRunning = false
            guard let flat else { return record(.failure("render_failed", on: .device), kind: .generic) }
            await rebaseStack(onto: flat)
        }
        processingOverlay = .generatingCaptions
        await runGenerateCaptions(language: language)
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
            state = .processing
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
            }
            editStack = stack
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
        Bundle.main.url(forResource: "finalcap-test-video", withExtension: "mp4")
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
