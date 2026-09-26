import SwiftUI
import UIKit

/// Export: renders the edit on the iPhone (or uses the original when there are no edits)
/// and offers Save to Photos, Save to Files (system folder picker) and Share.
struct ExportSheet: View {
    @Environment(\.dismiss) private var dismiss
    var videoURL: URL?
    var state: EditorState
    var stack: EditStack? = nil

    @StateObject private var controller = ExportController()

    /// Options shown in the sheet, in order.
    static let destinations = ExportController.Destination.allCases

    private var isPhoto: Bool { ExportController.isPhoto(stack: stack, fallbackURL: videoURL) }

    var body: some View {
        NavigationStack {
            VStack(spacing: 18) {
                Image(systemName: isPhoto ? "photo" : "square.and.arrow.up")
                    .font(.system(size: 40))
                    .foregroundStyle(AppTheme.accent)

                Text(statusCopy)
                    .font(.footnote)
                    .foregroundStyle(AppTheme.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
                    .accessibilityIdentifier("ExportStatus")

                progressSection

                VStack(spacing: 10) {
                    ForEach(Self.destinations) { destination in
                        Button {
                            controller.save(to: destination, stack: stack, fallbackURL: videoURL)
                        } label: {
                            Label(destination.title, systemImage: destination.systemImage)
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(destination == .photos ? AppTheme.accent : AppTheme.surfaceElevated)
                        .foregroundStyle(destination == .photos ? Color.black : AppTheme.textPrimary)
                        .disabled(!canExport || controller.isRunning)
                        .accessibilityIdentifier(destination == .photos ? "SaveToPhotos" : "SaveToFiles")
                    }

                    if let url = controller.renderedURL {
                        ShareLink(item: url) {
                            Label("Share", systemImage: "square.and.arrow.up")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .disabled(controller.isRunning)
                    }
                }
                .padding(.horizontal)

                if controller.isRunning, case .rendering = controller.phase {
                    Button("Cancel", role: .cancel) { controller.cancel() }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("ExportCancel")
                }

                if controller.showNotifyOffer, controller.isRunning {
                    Button(UXCopy.exportNotifyMe) { controller.requestNotifications() }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppTheme.accent)
                        .accessibilityIdentifier("ExportNotifyMe")
                }

                if controller.photosPermissionDenied {
                    HStack(spacing: 6) {
                        Text(UXCopy.photosPermissionDenied)
                            .font(.caption)
                            .foregroundStyle(AppTheme.textSecondary)
                        Button("Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) {
                                UIApplication.shared.open(url)
                            }
                        }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AppTheme.accent)
                    }
                    .padding(.horizontal)
                    .accessibilityIdentifier("PhotosPermissionNote")
                }

                Spacer()
            }
            .padding(.vertical, 24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(AppTheme.background.ignoresSafeArea())
            .overlay(alignment: .bottom) { toastView }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        controller.cancel()
                        dismiss()
                    }
                }
            }
            .navigationTitle(isPhoto ? UXCopy.exportPhotoTitle : "Export")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(item: Binding(
                get: { controller.filesPickerURL.map(ExportFile.init) },
                set: { if $0 == nil { controller.filesPickerURL = nil } }
            )) { file in
                DocumentExportPicker(url: file.url) { saved in
                    controller.filesPickerURL = nil
                    if saved { controller.toast = UXCopy.savedToFiles }
                }
                .ignoresSafeArea()
            }
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(controller.isRunning)
        .accessibilityIdentifier("ExportSheet")
    }

    @ViewBuilder
    private var toastView: some View {
        if let toast = controller.toast {
            Text(toast)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppTheme.textPrimary)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(AppTheme.surfaceElevated)
                .clipShape(Capsule())
                .padding(.bottom, 24)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .accessibilityIdentifier("ExportToast")
                .task(id: toast) {
                    try? await Task.sleep(nanoseconds: 2_500_000_000)
                    withAnimation { controller.toast = nil }
                }
        }
    }

    @ViewBuilder
    private var progressSection: some View {
        switch controller.phase {
        case .rendering(let percent):
            VStack(spacing: 8) {
                ProgressView(value: Double(percent), total: 100)
                    .tint(AppTheme.accent)
                Text(UXCopy.exportRendering(percent: percent))
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(AppTheme.textPrimary)
                Text(UXCopy.exportLeaveHint)
                    .font(.caption)
                    .foregroundStyle(AppTheme.textSecondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal)
            .accessibilityIdentifier("ExportProgress")
        case .saving:
            ProgressView().tint(AppTheme.accent)
        default:
            EmptyView()
        }
    }

    private var canExport: Bool {
        (stack != nil || videoURL != nil) && state != .processing && state != .uploading
    }

    private var statusCopy: String {
        if case .failed(let message) = controller.phase { return message }
        switch state {
        case .empty:
            return isPhoto ? "Import a photo before saving." : "Import a video before exporting."
        case .uploading:
            return "Still uploading…"
        case .processing:
            return "Finishing your edit — export when it's done."
        case .ready, .failed:
            if controller.renderedURL != nil, stack?.entries.isEmpty == false { return UXCopy.exportRenderedLocal }
            return isPhoto
                ? "Saves the edited photo in its original format."
                : "Renders your edits on your iPhone."
        }
    }
}

private struct ExportFile: Identifiable {
    let url: URL
    var id: String { url.path }
}

/// System "Save to Files" folder picker (exports a copy).
struct DocumentExportPicker: UIViewControllerRepresentable {
    var url: URL
    var onFinish: (Bool) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIDocumentPickerViewController, context: Context) {}

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let onFinish: (Bool) -> Void
        init(onFinish: @escaping (Bool) -> Void) { self.onFinish = onFinish }
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { onFinish(true) }
        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { onFinish(false) }
    }
}

#Preview {
    ExportSheet(videoURL: nil, state: .empty)
}
