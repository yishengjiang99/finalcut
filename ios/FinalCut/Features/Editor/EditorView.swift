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
                freeRemaining: appModel.dailyRemaining
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
                    processingMessage: model.processingOverlay.message
                )
                .frame(maxHeight: 240)
                if let importError = model.importError {
                    ImportErrorBanner(message: importError, photosPickerItem: $model.photosPickerItem)
                }
            }

            Divider().overlay(AppTheme.border)

            ChatView(messages: model.messages, onRetry: { model.retry($0) })
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
                importEnabled: importEnabled
            )
        }
        .background(AppTheme.background.ignoresSafeArea())
        .accessibilityIdentifier("Editor")
        .sheet(isPresented: $showExport) {
            ExportSheet(videoURL: model.localVideoURL, state: model.state)
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

    /// Shared API client from AppModel (jobs for long FFmpeg edits; captions sync).
    var apiClient: APIClient?
    /// Server reported the free usage limit (402 `paywall` / 429 `daily_limit_reached`).
    var onPaywallRequired: (() -> Void)?
    /// An inference request completed (success or failure) — refresh quota display.
    var onInferenceFinished: (() -> Void)?

    /// Sample chips (photo-safe set for photos). Each maps to a correct tool with complete args.
    var sampleChips: [String] { EditorRoute.chips(isPhoto: isPhoto) }

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

    func sendMessage() {
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        messages.append(ChatMessage(role: .user, content: text))
        composerText = ""
        lastError = nil

        let route = EditorRoute.route(for: text)
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
            localVideoURL = out
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
                ClientChatRequest(messages: conversation, media: await currentMedia())
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
                    ClientChatRequest(messages: conversation, media: await currentMedia())
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
        case .invalidArguments, .generic:
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
                "audio": .array(["m4a"].map { .string($0) }),
            ])
        }
    }

    private func runCaptionsTool(language: String, translateLanguage: String?, burnIn: Bool) async -> ClientToolResult {
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
        guard let client = apiClient, let mediaURL = localVideoURL else {
            return record(.failure("no_media", on: .server), kind: .generic)
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
            localVideoURL = out
            messages.append(ChatMessage(role: .system, content: "Applied \(tool)"))
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
