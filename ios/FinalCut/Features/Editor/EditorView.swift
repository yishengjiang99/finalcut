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
                onImport: { model.presentImporter = true },
                onExport: { showExport = true }
            )

            PreviewPaneView(
                state: model.state,
                videoURL: model.localVideoURL
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
                onImport: { model.presentImporter = true },
                onSend: { model.sendMessage() }
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
            model.handleImport(result)
        }
        .onChange(of: model.photosPickerItem) { _, item in
            Task { await model.loadPhotosPickerItem(item) }
        }
        .onAppear {
            model.apiClient = appModel.apiClient
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

    /// Shared API client from AppModel (jobs path preferred over sync process-video).
    var apiClient: APIClient?

    let sampleChips = ["Trim silence", "Add captions", "Vertical crop", "Highlight reel"]

    private var processingTask: Task<Void, Never>?

    func handleImport(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            guard let url = urls.first else { return }
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            state = .uploading
            // Stub: copy/reference locally; real upload hits async jobs later.
            localVideoURL = url
            state = .ready
            messages.append(ChatMessage(role: .system, content: "Imported \(url.lastPathComponent)"))
        case .failure(let error):
            state = .failed
            lastError = error.localizedDescription
        }
    }

    func loadPhotosPickerItem(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        state = .uploading
        do {
            if let data = try await item.loadTransferable(type: Data.self) {
                let tmp = FileManager.default.temporaryDirectory
                    .appendingPathComponent(UUID().uuidString + ".mov")
                try data.write(to: tmp)
                localVideoURL = tmp
                state = .ready
                messages.append(ChatMessage(role: .system, content: "Imported from Photos"))
            } else {
                state = .empty
            }
        } catch {
            state = .failed
            lastError = error.localizedDescription
        }
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
        // Dimmer stays up through queued|running; only terminal flips ready/failed.
        state = .processing
        messages.append(
            ChatMessage(
                role: .assistant,
                content: "Got it — running “\(text)” via async jobs API (poll-only; no on-device FFmpeg).",
                resultThumbnailURLs: []
            )
        )
        processingTask?.cancel()
        processingTask = Task { await runJobsEdit(prompt: text) }
    }

    /// Prefer POST /api/jobs/process-video + poll GET /api/jobs/:id.
    /// Without a local video or client, simulate the same status → editor mapping.
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
            // Prod E2E: sample mode uses header `sample-access-token` (not Bearer).
            if client.sampleModeEnabled {
                _ = try await client.ensureSampleAccessToken()
            }
            let accessed = videoURL.startAccessingSecurityScopedResource()
            defer { if accessed { videoURL.stopAccessingSecurityScopedResource() } }
            let videoData = try Data(contentsOf: videoURL)
            let operation = Self.mapPromptToOperation(prompt)
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
            // No clip imported — return to empty after demo poll completes.
            state = .empty
        }
        messages.append(
            ChatMessage(
                role: .system,
                content: "Demo job \(fakeId.prefix(8)) finished (import a video to hit the real jobs API)."
            )
        )
    }

    /// Lightweight prompt → server operation mapping for the scaffold.
    static func mapPromptToOperation(_ prompt: String) -> String {
        let lower = prompt.lowercased()
        if lower.contains("silence") { return "audio_silence_remove" }
        if lower.contains("trim") { return "trim_video" }
        if lower.contains("vertical") || lower.contains("crop") { return "crop_video" }
        // Captions use dedicated caption APIs; fall back to trim for scaffold jobs path.
        return "trim_video"
    }

    static func mimeType(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "mov": return "video/quicktime"
        case "m4v": return "video/x-m4v"
        default: return "video/mp4"
        }
    }
}

#Preview {
    EditorView()
        .environmentObject(AppModel())
}
