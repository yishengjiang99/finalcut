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

    let sampleChips = ["Trim silence", "Add captions", "Vertical crop", "Highlight reel"]

    func handleImport(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            guard let url = urls.first else { return }
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            state = .uploading
            // Stub: copy/reference locally; real upload hits process-video later.
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
        state = .processing
        // Stub assistant reply — real path streams POST /api/chat then server FFmpeg.
        messages.append(
            ChatMessage(
                role: .assistant,
                content: "Got it — I'll run “\(text)” via the server Node/FFmpeg API (no on-device FFmpeg).",
                resultThumbnailURLs: []
            )
        )
        state = localVideoURL == nil ? .empty : .ready
    }
}

#Preview {
    EditorView()
        .environmentObject(AppModel())
}
