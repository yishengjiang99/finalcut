import SwiftUI
import PhotosUI

/// Editor — single root (not tabs). Regions top→bottom:
/// TopBar → Preview → Chat → SampleChips → Composer. ExportSheet as sheet.
struct EditorView: View {
    @EnvironmentObject private var appModel: AppModel
    @StateObject private var model = EditorViewModel()
    @State private var showExport = false

    var body: some View {
        VStack(spacing: 0) {
            TopBarView(
                onImport: { model.presentPhotosPicker = true },
                onImportFiles: { model.presentImporter = true },
                onExport: { showExport = true },
                importEnabled: importEnabled,
                importLabel: appModel.isTestVideoMode ? "Test video" : "Import"
            )

            PreviewPaneView(
                state: model.state,
                videoURL: model.localVideoURL,
                processingMessage: model.processingOverlay.message
            )
            .frame(maxHeight: 240)

            Divider().overlay(AppTheme.border)

            ChatView(messages: model.messages)
                .frame(maxHeight: .infinity)

            if model.showSampleChips {
                SampleChipsView(chips: model.sampleChips) { chip in
                    model.applySampleChip(chip)
                }
            }

            ComposerView(
                text: $model.composerText,
                onImport: { model.presentPhotosPicker = true },
                onImportFiles: { model.presentImporter = true },
                onSend: { model.sendMessage() },
                importEnabled: importEnabled
            )
        }
        .background(AppTheme.background.ignoresSafeArea())
        .accessibilityIdentifier("Editor")
        .sheet(isPresented: $showExport) {
            ExportSheet(videoURL: model.localVideoURL, state: model.state)
        }
        .photosPicker(
            isPresented: $model.presentPhotosPicker,
            selection: $model.photosPickerItem,
            matching: .videos
        )
        .fileImporter(
            isPresented: $model.presentImporter,
            allowedContentTypes: [.movie, .mpeg4Movie, .quickTimeMovie],
            allowsMultipleSelection: false
        ) { result in
            Task { await model.handleImport(result) }
        }
        .onChange(of: model.photosPickerItem) { _, item in
            Task { await model.loadPhotosPickerItem(item) }
        }
        .onAppear {
            model.apiClient = appModel.apiClient
            if appModel.isTestVideoMode {
                model.loadBundledTestVideo()
            } else {
                model.resetBundledTestVideoIfNeeded()
            }
        }
        .onChange(of: appModel.isTestVideoMode) { _, isTestVideoMode in
            if isTestVideoMode {
                model.loadBundledTestVideo()
            } else {
                model.resetBundledTestVideoIfNeeded()
            }
        }
        .overlay(alignment: .top) {
            if model.state == .failed, let err = model.lastError {
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
        !appModel.isTestVideoMode && model.state != .uploading && model.state != .processing
    }
}

@MainActor
final class EditorViewModel: ObservableObject {
    @Published var state: EditorState = .empty
    @Published var messages: [ChatMessage] = []
    @Published var composerText = ""
    @Published var localVideoURL: URL?
    @Published var presentImporter = false
    @Published var presentPhotosPicker = false
    @Published var photosPickerItem: PhotosPickerItem?
    @Published var showSampleChips = true
    @Published var lastError: String?
    @Published var activeJobId: String?
    @Published var processingOverlay: ProcessingOverlayKind = .editing
    @Published var captionArtifacts = CaptionArtifacts()

    /// Shared API client from AppModel (jobs for long FFmpeg edits; captions sync).
    var apiClient: APIClient?

    /// Demo chips for the captions three-step flow + other edits.
    let sampleChips = [
        "Generate captions",
        "Translate to Spanish",
        "Burn in",
        "Trim silence",
        "Vertical crop",
    ]

    private var processingTask: Task<Void, Never>?

    enum CaptionIntent: Equatable {
        case generate
        case translate(language: String)
        case burnIn
        case otherEdit
    }

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
                finishImport(video, message: "Imported \(url.lastPathComponent)")
            } catch {
                state = .failed
                lastError = error.localizedDescription
            }
        case .failure(let error):
            state = .failed
            lastError = error.localizedDescription
        }
    }

    func loadPhotosPickerItem(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        state = .uploading
        lastError = nil
        // Reset selection so choosing the same video again triggers another import.
        defer { photosPickerItem = nil }
        do {
            guard let video = try await item.loadTransferable(type: ImportedVideo.self) else {
                throw APIError.message("Couldn't load this video from Photos. Try another video.")
            }
            finishImport(video, message: "Imported from Photos")
        } catch {
            state = .failed
            lastError = error.localizedDescription
        }
    }

    private func finishImport(_ video: ImportedVideo, message: String) {
        localVideoURL = video.url
        captionArtifacts = CaptionArtifacts()
        state = .ready
        messages.append(ChatMessage(role: .system, content: message))
    }

    func loadBundledTestVideo() {
        guard let url = bundledTestVideoURL else {
            state = .failed
            lastError = "Test video unavailable"
            return
        }
        guard localVideoURL != url else { return }
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

    func resetBundledTestVideoIfNeeded() {
        guard let localVideoURL, localVideoURL == bundledTestVideoURL else { return }
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

        let intent = Self.detectCaptionIntent(text)
        processingOverlay = Self.overlay(for: intent)
        state = .processing

        processingTask?.cancel()
        processingTask = Task {
            switch intent {
            case .generate:
                await runGenerateCaptions()
            case .translate(let language):
                await runTranslateCaptions(targetLanguage: language)
            case .burnIn:
                await runBurnIn()
            case .otherEdit:
                messages.append(
                    ChatMessage(
                        role: .assistant,
                        content: "Got it — running “\(text)” via async jobs API (poll-only; no on-device FFmpeg)."
                    )
                )
                await runJobsEdit(prompt: text)
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

    private func runGenerateCaptions() async {
        do {
            let client = try await ensureClientAndToken()
            let (videoData, videoURL) = try readLocalVideoData()
            processingOverlay = .generatingCaptions
            let result = try await client.generateCaptions(
                videoData: videoData,
                mimeType: Self.mimeType(for: videoURL)
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

    private func finishCaptionFailure(_ error: APIError, fallback: String? = nil) {
        state = .failed
        lastError = error.errorDescription
        processingOverlay = .editing
        let copy: String
        if case .noSpeechDetected = error {
            copy = error.captionsChatMessage
        } else if let fallback {
            copy = fallback
        } else {
            copy = error.captionsChatMessage
        }
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

    // MARK: - Other long FFmpeg edits → async jobs poll

    /// Prefer POST /api/jobs/process-video + poll GET /api/jobs/:id (not for burn/add_audio).
    func runJobsEdit(prompt: String) async {
        if let client = apiClient, let videoURL = localVideoURL {
            await runRealJobsEdit(client: client, videoURL: videoURL, prompt: prompt)
        } else {
            await simulateJobsLifecycle()
        }
    }

    private func applyJobStatus(_ status: JobStatus, error: String? = nil) {
        state = status.editorState
        if status == .failed {
            lastError = error ?? "Job failed"
        }
    }

    private func runRealJobsEdit(client: APIClient, videoURL: URL, prompt: String) async {
        do {
            if client.sampleModeEnabled {
                _ = try await client.ensureSampleAccessToken()
            }
            let accessed = videoURL.startAccessingSecurityScopedResource()
            defer { if accessed { videoURL.stopAccessingSecurityScopedResource() } }
            let videoData = try Data(contentsOf: videoURL)
            let operation = Self.mapPromptToOperation(prompt)
            processingOverlay = .editing
            let enqueue = try await client.submitProcessVideoJob(
                videoData: videoData,
                fileName: videoURL.lastPathComponent,
                mimeType: Self.mimeType(for: videoURL),
                operation: operation,
                args: [:]
            )
            activeJobId = enqueue.jobId
            applyJobStatus(enqueue.status)

            let final = try await client.pollJob(id: enqueue.jobId) { [weak self] poll in
                Task { @MainActor in
                    self?.applyJobStatus(poll.status, error: poll.error)
                }
            }
            applyJobStatus(final.status, error: final.error)

            if final.status == .succeeded {
                if let resultData = try? await client.downloadJobResult(
                    id: enqueue.jobId,
                    resultUrl: final.resultUrl
                ) {
                    let out = FileManager.default.temporaryDirectory
                        .appendingPathComponent("\(enqueue.jobId).mp4")
                    try? resultData.write(to: out)
                    localVideoURL = out
                }
                messages.append(
                    ChatMessage(
                        role: .system,
                        content: "Job \(enqueue.jobId) succeeded"
                            + (final.resultUrl.map { " — \($0)" } ?? "")
                    )
                )
            }
        } catch is CancellationError {
            // User sent another message or view torn down.
        } catch {
            state = .failed
            lastError = error.localizedDescription
            messages.append(ChatMessage(role: .system, content: "Job error: \(error.localizedDescription)"))
        }
    }

    /// Local demo when no video/client: walk queued → running → succeeded while staying processing until terminal.
    private func simulateJobsLifecycle() async {
        let fakeId = UUID().uuidString
        activeJobId = fakeId
        let steps: [JobStatus] = [.queued, .running, .succeeded]
        for status in steps {
            if Task.isCancelled { return }
            applyJobStatus(status)
            if !status.isTerminal {
                try? await Task.sleep(nanoseconds: 400_000_000)
            }
        }
        if localVideoURL == nil {
            state = .empty
        }
        messages.append(
            ChatMessage(
                role: .system,
                content: "Demo job \(fakeId.prefix(8)) finished (import a video to hit the real jobs API)."
            )
        )
    }

    /// Lightweight prompt → server operation mapping for non-caption edits.
    /// Never maps to burn_subtitles / add_audio_track (those are sync process-video only).
    static func mapPromptToOperation(_ prompt: String) -> String {
        let lower = prompt.lowercased()
        if lower.contains("silence") { return "audio_silence_remove" }
        if lower.contains("trim") { return "trim_video" }
        if lower.contains("vertical") || lower.contains("crop") { return "crop_video" }
        return "trim_video"
    }

    static func mimeType(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "mov": return "video/quicktime"
        case "m4v": return "video/x-m4v"
        default: return "video/mp4"
        }
    }

    private var bundledTestVideoURL: URL? {
        Bundle.main.url(forResource: "finalcap-test-video", withExtension: "mp4")
    }
}

#Preview {
    EditorView()
        .environmentObject(AppModel())
}
