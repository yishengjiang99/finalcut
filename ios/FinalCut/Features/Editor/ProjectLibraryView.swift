import SwiftUI

/// Project history — the library of saved editing projects (issue #125,
/// Phase 1), modelled on chat-app conversation lists: title-first rows in
/// time sections (Pinned, Today, Yesterday, Previous 7 Days, Previous 30
/// Days, then months), with the video delta of a cover thumbnail, duration
/// and clip count per row. Rows come from `ProjectLibrary`'s rebuildable
/// index; opening a row loads that project into the editor behind this sheet.
/// Pin/Archive/Duplicate/Search arrive in later phases — Phase 1 is open,
/// rename, delete.
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

    private var sections: [(title: String, rows: [ProjectIndexRow])] {
        let buckets = ProjectLibrary.buckets(from: rows)
        return [("Pinned", buckets.pinned), ("Projects", buckets.projects)].filter { !$0.rows.isEmpty }
    }

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
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
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
            ForEach(sections, id: \.title) { section in
                Section(section.title) {
                    ForEach(section.rows) { row in
                        rowView(row)
                            .listRowBackground(AppTheme.surfaceElevated)
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) { beginDelete(row) } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                                Button { beginRename(row) } label: {
                                    Label("Rename", systemImage: "pencil")
                                }
                            }
                            .contextMenu {
                                Button { open(row) } label: {
                                    Label("Open", systemImage: "play.circle")
                                }
                                Button { beginRename(row) } label: {
                                    Label("Rename", systemImage: "pencil")
                                }
                                Button(role: .destructive) { beginDelete(row) } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
    }

    private func rowView(_ row: ProjectIndexRow) -> some View {
        Button { open(row) } label: {
            HStack(spacing: 12) {
                coverView(row)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
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
