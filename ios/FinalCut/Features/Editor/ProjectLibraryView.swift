import SwiftUI
import UIKit

/// Project history — the library of saved editing projects (issue #125,
/// Phase 1), modelled on chat-app conversation lists: title-first rows in
/// time sections (Pinned, Today, Yesterday, Previous 7 Days, Previous 30
/// Days, then months), with the video delta of a cover thumbnail, duration
/// and clip count per row. Rows come from `ProjectLibrary`'s rebuildable
/// index; opening a row loads that project into the editor behind this sheet.
/// Phase 3: title/date search, a Pinned section above Projects (last edited
/// first), archived projects behind an "Archived (N)" row, pin/archive
/// swipes, and delete only from the context menu with a confirmation.
struct ProjectLibraryView: View {
    @ObservedObject var model: EditorViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var rows: [ProjectIndexRow] = []
    @State private var coverImages: [UUID: UIImage] = [:]
    @State private var renameRow: ProjectIndexRow?
    @State private var renameText = ""
    @State private var deleteRow: ProjectIndexRow?
    @State private var deleteSizeText = ""
    @State private var openFailed = false
    @State private var query = ""
    @State private var showArchived = false
    /// The just-archived row the Undo toast can restore.
    @State private var undoArchiveRow: ProjectIndexRow?
    @State private var showStorage = false
    @State private var showNudge = false

    private var buckets: ProjectLibraryBuckets {
        ProjectLibrary.buckets(from: rows, query: query)
    }

    private var archivedCount: Int { rows.filter(\.isArchived).count }

    var body: some View {
        NavigationStack {
            Group {
                if rows.isEmpty {
                    emptyState
                } else {
                    list
                }
            }
            .background(AppTheme.background.ignoresSafeArea())
            .navigationTitle("Projects")
            .searchable(text: $query, prompt: "Search titles or dates")
            .navigationDestination(isPresented: $showArchived) {
                ArchivedProjectsList(rows: rows.filter(\.isArchived)) { row in
                    AnyView(decoratedRow(row))
                }
            }
            .navigationDestination(isPresented: $showStorage) {
                ProjectStorageView(model: model) { rows = ProjectLibrary.loadRows() }
            }
            .overlay(alignment: .bottom) { undoToast }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button { showStorage = true } label: {
                        Label("Storage", systemImage: "internaldrive")
                    }
                    .accessibilityIdentifier("ProjectStorage")
                }
            }
        }
        .task { await reload() }
        .alert(
            "Rename project",
            isPresented: Binding(
                get: { renameRow != nil },
                set: { if !$0 { renameRow = nil } }
            ),
            presenting: renameRow
        ) { row in
            TextField("Project name", text: $renameText)
            Button("Save") { commitRename(row) }
            Button("Cancel", role: .cancel) { renameRow = nil }
        } message: { _ in
            Text("The new name applies everywhere this project appears.")
        }
        .alert(
            "Delete this project?",
            isPresented: Binding(
                get: { deleteRow != nil },
                set: { if !$0 { deleteRow = nil } }
            ),
            presenting: deleteRow
        ) { row in
            Button("Delete permanently", role: .destructive) { commitDelete(row) }
            Button("Cancel", role: .cancel) { deleteRow = nil }
        } message: { row in
            Text("“\(row.title)” and the media copied into it will be deleted permanently. This frees \(deleteSizeText).")
        }
        .alert("Couldn't open that project", isPresented: $openFailed) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Its first clip's file is missing, so there's nothing to preview. You can delete the project from the list.")
        }
    }

    // MARK: List

    private var list: some View {
        List {
            let current = buckets
            if showNudge, query.isEmpty {
                Section { archiveNudge }
            }
            if !current.pinned.isEmpty {
                Section("Pinned") {
                    ForEach(current.pinned) { decoratedRow($0) }
                }
            }
            Section("Projects") {
                if current.pinned.isEmpty, current.projects.isEmpty, !query.isEmpty {
                    Text(ProjectLibraryView.noMatchText(query))
                        .foregroundStyle(AppTheme.textSecondary)
                        .listRowBackground(AppTheme.surfaceElevated)
                }
                ForEach(current.projects) { decoratedRow($0) }
            }
            if archivedCount > 0 {
                Section {
                    Button { showArchived = true } label: {
                        HStack {
                            Label("Archived (\(archivedCount))", systemImage: "archivebox")
                                .foregroundStyle(AppTheme.textPrimary)
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(AppTheme.textSecondary)
                        }
                    }
                    .listRowBackground(AppTheme.surfaceElevated)
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
    }

    /// Gentle archive suggestion (#125 Phase 4): never archives on its own;
    /// "Not now" snoozes it for `ProjectStorage.nudgeSnooze`.
    private var archiveNudge: some View {
        let stale = ProjectStorage.staleProjects(rows)
        let days = Int(ProjectStorage.staleThreshold / 86_400)
        return VStack(alignment: .leading, spacing: 8) {
            Text(stale.count == 1
                 ? "1 project hasn't been opened in \(days)+ days. Archive it to tidy your list? Nothing is deleted."
                 : "\(stale.count) projects haven't been opened in \(days)+ days. Archive them to tidy your list? Nothing is deleted.")
                .font(.subheadline)
                .foregroundStyle(AppTheme.textPrimary)
            HStack(spacing: 16) {
                Button(stale.count == 1 ? "Archive it" : "Archive them") {
                    for row in stale { model.setProjectArchived(id: row.id, true) }
                    rows = ProjectLibrary.loadRows()
                    showNudge = false
                }
                .buttonStyle(.borderless)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppTheme.accent)
                Button("Not now") {
                    ProjectStorage.dismissArchiveNudge()
                    showNudge = false
                }
                .buttonStyle(.borderless)
                .font(.subheadline)
                .foregroundStyle(AppTheme.textSecondary)
            }
        }
        .listRowBackground(AppTheme.surfaceElevated)
    }

    static func noMatchText(_ query: String) -> String {
        "No projects match \"\(query.trimmingCharacters(in: .whitespacesAndNewlines))\""
    }

    /// A row with its swipes and context menu. Leading swipe pins/unpins;
    /// trailing swipe archives (Unarchive in the Archived list). A swipe never
    /// deletes: Delete is only in the context menu, behind a confirmation.
    private func decoratedRow(_ row: ProjectIndexRow) -> some View {
        rowView(row)
            .listRowBackground(AppTheme.surfaceElevated)
            .swipeActions(edge: .leading) {
                Button { setPinned(row, !row.isPinned) } label: {
                    Label(row.isPinned ? "Unpin" : "Pin", systemImage: row.isPinned ? "pin.slash" : "pin")
                }
                .tint(.yellow)
            }
            .swipeActions(edge: .trailing) {
                Button { setArchived(row, !row.isArchived) } label: {
                    Label(row.isArchived ? "Unarchive" : "Archive", systemImage: "archivebox")
                }
                .tint(.gray)
            }
            .contextMenu {
                Button { setPinned(row, !row.isPinned) } label: {
                    Label(row.isPinned ? "Unpin" : "Pin", systemImage: row.isPinned ? "pin.slash" : "pin")
                }
                Button { setArchived(row, !row.isArchived) } label: {
                    Label(row.isArchived ? "Unarchive" : "Archive", systemImage: "archivebox")
                }
                Button { beginRename(row) } label: {
                    Label("Rename", systemImage: "pencil")
                }
                Button(role: .destructive) { beginDelete(row) } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
    }

    @ViewBuilder
    private var undoToast: some View {
        if let row = undoArchiveRow {
            HStack(spacing: 12) {
                Text("Archived “\(row.title)”")
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Button("Undo") {
                    undoArchiveRow = nil
                    model.setProjectArchived(id: row.id, false)
                    rows = ProjectLibrary.loadRows()
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppTheme.accent)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(AppTheme.surfaceElevated, in: Capsule())
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .task(id: row.id) {
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                if undoArchiveRow?.id == row.id { undoArchiveRow = nil }
            }
        }
    }

    private func rowView(_ row: ProjectIndexRow) -> some View {
        Button { open(row) } label: {
            HStack(spacing: 12) {
                coverView(row)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        if row.isPinned {
                            Image(systemName: "pin.fill")
                                .font(.caption2)
                                .foregroundStyle(.yellow)
                                .accessibilityLabel("Pinned")
                        }
                        Text(row.title)
                            .font(.body.weight(.medium))
                            .foregroundStyle(AppTheme.textPrimary)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Text(ProjectLibrary.relativeEditDescription(for: row.updatedAt))
                            .font(.caption2)
                            .foregroundStyle(AppTheme.textSecondary)
                            .lineLimit(1)
                    }
                    Text(subtitle(row))
                        .font(.caption)
                        .foregroundStyle(AppTheme.textSecondary)
                        .lineLimit(1)
                    if model.timelineProject?.id == row.id {
                        Text("Open now")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(AppTheme.accent)
                    }
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(model.isBusy)
    }

    private func subtitle(_ row: ProjectIndexRow) -> String {
        var text = "\(ProjectLibrary.durationDescription(row.durationSeconds)) · \(row.clipCount == 1 ? "1 clip" : "\(row.clipCount) clips")"
        if row.audioClipCount > 0 {
            text += " · \(row.audioClipCount) audio"
        }
        return text
    }

    /// Cover thumbnail, or the placeholder tile (neutral + play glyph +
    /// duration) when the project has no cover yet or its media is missing —
    /// the same tile serves both states, per the issue.
    @ViewBuilder
    private func coverView(_ row: ProjectIndexRow) -> some View {
        ZStack {
            if let image = coverImages[row.id] {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                AppTheme.surface
                Image(systemName: "play.fill")
                    .font(.caption)
                    .foregroundStyle(AppTheme.textSecondary)
                VStack {
                    Spacer()
                    HStack {
                        Spacer()
                        Text(ProjectLibrary.durationDescription(row.durationSeconds))
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 3)
                            .padding(.vertical, 1)
                            .background(Color.black.opacity(0.55))
                    }
                }
            }
        }
        .frame(width: 64, height: 36)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "film.stack")
                .font(.system(size: 34))
                .foregroundStyle(AppTheme.textSecondary)
            Text("No saved projects yet")
                .font(.headline)
                .foregroundStyle(AppTheme.textPrimary)
            Text("Projects you build on the timeline are saved automatically and show up here.")
                .font(.subheadline)
                .foregroundStyle(AppTheme.textSecondary)
                .multilineTextAlignment(.center)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: Actions

    private func open(_ row: ProjectIndexRow) {
        guard !model.isBusy else { return }
        Task {
            if await model.openProject(id: row.id) {
                dismiss()
            } else {
                openFailed = true
            }
        }
    }

    private func setPinned(_ row: ProjectIndexRow, _ pinned: Bool) {
        model.setProjectPinned(id: row.id, pinned)
        rows = ProjectLibrary.loadRows()
    }

    private func setArchived(_ row: ProjectIndexRow, _ archived: Bool) {
        model.setProjectArchived(id: row.id, archived)
        rows = ProjectLibrary.loadRows()
        withAnimation { undoArchiveRow = archived ? row : nil }
    }

    private func beginRename(_ row: ProjectIndexRow) {
        renameText = row.title
        renameRow = row
    }

    private func commitRename(_ row: ProjectIndexRow) {
        let newName = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        renameRow = nil
        guard !newName.isEmpty, newName != row.title else { return }
        Task {
            await model.renameProject(id: row.id, to: newName)
            rows = ProjectLibrary.loadRows()
        }
    }

    private func beginDelete(_ row: ProjectIndexRow) {
        deleteSizeText = ByteCountFormatter.string(
            fromByteCount: ProjectLibrary.directorySize(row.id), countStyle: .file)
        deleteRow = row
    }

    private func commitDelete(_ row: ProjectIndexRow) {
        deleteRow = nil
        _ = try? model.deleteProject(id: row.id)
        coverImages[row.id] = nil
        rows = ProjectLibrary.loadRows()
    }

    // MARK: Loading

    private func reload() async {
        rows = ProjectLibrary.loadRows()
        showNudge = ProjectStorage.shouldShowArchiveNudge(rows)
        loadCoverImages()
        // Lazily generate covers for rows that don't have one yet (best
        // effort, off the save path — see ProjectLibrary), then pick them up.
        var generatedAny = false
        for row in rows where ProjectLibrary.coverURL(projectID: row.id) == nil {
            await ProjectLibrary.generateCoverIfMissing(projectID: row.id)
            generatedAny = true
        }
        if generatedAny {
            rows = ProjectLibrary.loadRows()
            loadCoverImages()
        }
    }

    private func loadCoverImages() {
        for row in rows where coverImages[row.id] == nil {
            if let url = ProjectLibrary.coverURL(projectID: row.id),
               let image = UIImage(contentsOfFile: url.path) {
                coverImages[row.id] = image
            }
        }
    }
}

/// The Archived list (#125 Phase 3): archived projects, last edited first, with
/// the same title/date search. Rows come decorated by the library (so the
/// trailing swipe reads Unarchive here).
struct ArchivedProjectsList: View {
    let rows: [ProjectIndexRow]
    let rowContent: (ProjectIndexRow) -> AnyView
    @State private var query = ""

    var body: some View {
        let archived = ProjectLibrary.buckets(from: rows, query: query).archived
        List {
            if archived.isEmpty {
                Text(query.isEmpty ? "No archived projects" : ProjectLibraryView.noMatchText(query))
                    .foregroundStyle(AppTheme.textSecondary)
                    .listRowBackground(AppTheme.surfaceElevated)
            }
            ForEach(archived) { rowContent($0) }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(AppTheme.background.ignoresSafeArea())
        .navigationTitle("Archived")
        .searchable(text: $query, prompt: "Search titles or dates")
    }
}

/// Storage (#125 Phase 4): library total, projects largest first, thumbnail
/// cache clearing (covers only, never project data), and per-project backup
/// export, duplicate, archive and delete.
struct ProjectStorageView: View {
    @ObservedObject var model: EditorViewModel
    var onChange: () -> Void

    @State private var entries: [ProjectStorageEntry] = []
    @State private var clearedText: String?
    @State private var deleteEntry: ProjectStorageEntry?
    @State private var exportURL: URL?
    @State private var exportFailed = false
    @State private var working = false

    private static func bytes(_ count: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: count, countStyle: .file)
    }

    var body: some View {
        let total = ProjectStorage.totalBytes(entries)
        let thumbnails = entries.reduce(Int64(0)) { $0 + $1.thumbnailBytes }
        List {
            Section {
                HStack {
                    Text("All projects")
                    Spacer()
                    Text(Self.bytes(total)).foregroundStyle(AppTheme.textSecondary)
                }
                .listRowBackground(AppTheme.surfaceElevated)
                Button {
                    let freed = ProjectStorage.clearThumbnailCache()
                    clearedText = "Freed \(Self.bytes(freed)). Thumbnails come back the next time the library shows them."
                    reload()
                } label: {
                    HStack {
                        Text("Clear thumbnail cache")
                        Spacer()
                        Text(Self.bytes(thumbnails)).foregroundStyle(AppTheme.textSecondary)
                    }
                }
                .disabled(thumbnails == 0)
                .listRowBackground(AppTheme.surfaceElevated)
            } footer: {
                Text("Clearing thumbnails never deletes projects, media or chats.")
            }
            Section("Largest first") {
                ForEach(entries) { entry in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(entry.title).lineLimit(1).foregroundStyle(AppTheme.textPrimary)
                            if entry.isArchived {
                                Text("Archived").font(.caption2).foregroundStyle(AppTheme.textSecondary)
                            }
                        }
                        Spacer()
                        Text(Self.bytes(entry.totalBytes)).foregroundStyle(AppTheme.textSecondary)
                    }
                    .listRowBackground(AppTheme.surfaceElevated)
                    .contextMenu {
                        Button { export(entry) } label: {
                            Label("Export backup", systemImage: "square.and.arrow.up")
                        }
                        Button { duplicate(entry) } label: {
                            Label("Duplicate (copies media)", systemImage: "plus.square.on.square")
                        }
                        Button {
                            model.setProjectArchived(id: entry.id, !entry.isArchived)
                            reload()
                        } label: {
                            Label(entry.isArchived ? "Unarchive" : "Archive", systemImage: "archivebox")
                        }
                        Button(role: .destructive) { deleteEntry = entry } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                    .swipeActions(edge: .trailing) {
                        Button { export(entry) } label: {
                            Label("Export", systemImage: "square.and.arrow.up")
                        }
                        .tint(AppTheme.accent)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(AppTheme.background.ignoresSafeArea())
        .navigationTitle("Storage")
        .overlay { if working { ProgressView() } }
        .onAppear { reload() }
        .alert("Thumbnail cache cleared", isPresented: Binding(
            get: { clearedText != nil }, set: { if !$0 { clearedText = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(clearedText ?? "") }
        .alert("Delete this project?", isPresented: Binding(
            get: { deleteEntry != nil }, set: { if !$0 { deleteEntry = nil } }), presenting: deleteEntry) { entry in
            Button("Delete permanently", role: .destructive) {
                _ = try? model.deleteProject(id: entry.id)
                deleteEntry = nil
                reload()
            }
            Button("Cancel", role: .cancel) { deleteEntry = nil }
        } message: { entry in
            Text("“\(entry.title)” and its media will be deleted permanently. This frees \(Self.bytes(entry.totalBytes)).")
        }
        .alert("Couldn't export that project", isPresented: $exportFailed) {
            Button("OK", role: .cancel) {}
        }
        .sheet(isPresented: Binding(get: { exportURL != nil }, set: { if !$0 { exportURL = nil } })) {
            if let url = exportURL { ActivityShareSheet(items: [url]) }
        }
    }

    private func reload() {
        entries = ProjectStorage.entries()
        onChange()
    }

    private func export(_ entry: ProjectStorageEntry) {
        working = true
        let id = entry.id
        Task { @MainActor in
            let url = await Task.detached { try? ProjectStorage.makeBackupArchive(projectID: id) }.value
            working = false
            if let url { exportURL = url } else { exportFailed = true }
        }
    }

    private func duplicate(_ entry: ProjectStorageEntry) {
        model.saveTimelineProject()
        _ = try? ProjectStorage.duplicate(projectID: entry.id)
        reload()
    }
}

/// UIActivityViewController for a backup file (share sheet, incl. Save to Files).
struct ActivityShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
