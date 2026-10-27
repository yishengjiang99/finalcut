import AVFoundation
import Foundation
import UIKit

/// One denormalized library row — everything the project-history list renders,
/// cached in `index.json` at the Projects root (issue #125, Phase 1). Content
/// fields (title, duration, clip counts) are derived from `project.json`, which
/// stays the source of truth; library-owned fields (`isPinned`, `lastOpenedAt`)
/// live only here and survive row rebuilds.
struct ProjectIndexRow: Codable, Equatable, Sendable, Identifiable {
    var id: UUID
    var title: String
    var createdAt: Date
    var updatedAt: Date
    var lastOpenedAt: Date?
    var durationSeconds: Double
    var clipCount: Int
    var audioClipCount: Int
    /// Display-transcript message count. Always 0 in Phase 1 — transcripts are
    /// persisted in Phase 2, which will start filling this in.
    var messageCount: Int = 0
    /// Cover image filename inside the project directory ("cover.jpg"), when one
    /// has been generated.
    var coverFilename: String?
    /// Pin/archive land as actions in Phase 3; the row carries the flags from the
    /// start so the sectioning below is already correct when they arrive.
    var isPinned: Bool = false
    var isArchived: Bool = false
    /// Modification time of `project.json` when this row was built. The
    /// precedence rule: if the project file is newer than this, the row is stale
    /// and is rebuilt on the spot (the two files are written separately and can
    /// disagree after a crash).
    var projectFileModifiedAt: Date
}

/// A titled bucket of rows for the history list (Pinned / Today / Yesterday /
/// Previous 7 Days / Previous 30 Days / one per older month).
struct ProjectLibrarySection: Identifiable, Equatable {
    var title: String
    var rows: [ProjectIndexRow]
    var id: String { title }
}

/// The across-project library service (issue #125, Phase 1) — the front door over
/// `ProjectStore`. Reads go through a rebuildable `index.json` cache so the list
/// never has to decode every project just to render; a stale row (per the
/// precedence rule above) is rebuilt from its project on the spot. All storage
/// is on-device; nothing here touches the network.
enum ProjectLibrary {
    static let currentIndexSchemaVersion = 1
    static let coverFilename = "cover.jpg"

    private static var indexURL: URL {
        ProjectStore.projectsRoot.appendingPathComponent("index.json")
    }

    // MARK: Index load / rebuild

    /// All library rows, most recently edited first. Rebuilds the index (or any
    /// stale rows) as needed and persists it when anything changed. Archived
    /// rows are included; sectioning decides what the list shows.
    static func loadRows() -> [ProjectIndexRow] {
        let stored = readIndex()
        let storedByID = Dictionary((stored?.rows ?? []).map { ($0.id, $0) },
                                    uniquingKeysWith: { first, _ in first })
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: ProjectStore.projectsRoot, includingPropertiesForKeys: nil) else { return [] }

        var rows: [ProjectIndexRow] = []
        var changed = stored == nil
        for entry in entries {
            guard let id = UUID(uuidString: entry.lastPathComponent) else { continue }
            let fileURL = ProjectStore.projectFileURL(id)
            guard let attrs = try? FileManager.default.attributesOfItem(atPath: fileURL.path),
                  let modified = attrs[.modificationDate] as? Date else { continue }
            let existing = storedByID[id]
            if let existing, existing.projectFileModifiedAt >= modified {
                // Fresh row: reuse it. A cover can appear without project.json
                // changing (generated lazily), so refresh just that field.
                var row = existing
                let cover = coverExists(id) ? coverFilename : nil
                if row.coverFilename != cover {
                    row.coverFilename = cover
                    changed = true
                }
                rows.append(row)
                continue
            }
            // Missing or stale row: rebuild from the project itself. A project
            // that no longer decodes is dropped from the index (its directory is
            // left untouched), matching `ProjectStore.loadAll()`'s behaviour.
            guard let project = try? ProjectStore.load(id) else { changed = true; continue }
            let created = (attrs[.creationDate] as? Date) ?? modified
            rows.append(makeRow(project: project, fileModified: modified,
                                fileCreated: created, existing: existing))
            changed = true
        }
        if Set(rows.map(\.id)) != Set(storedByID.keys) { changed = true }
        rows.sort { $0.updatedAt > $1.updatedAt }
        if changed { writeIndex(rows) }
        return rows
    }

    private static func makeRow(project: EditorProject, fileModified: Date,
                                fileCreated: Date, existing: ProjectIndexRow?) -> ProjectIndexRow {
        ProjectIndexRow(
            id: project.id,
            title: project.name,
            createdAt: existing?.createdAt ?? fileCreated,
            updatedAt: fileModified,
            lastOpenedAt: existing?.lastOpenedAt,
            durationSeconds: project.durationSeconds,
            clipCount: project.videoClips.count,
            audioClipCount: project.audioTracks.reduce(0) { $0 + $1.clips.count },
            messageCount: existing?.messageCount ?? 0,
            coverFilename: coverExists(project.id) ? coverFilename : nil,
            isPinned: existing?.isPinned ?? false,
            isArchived: existing?.isArchived ?? false,
            projectFileModifiedAt: fileModified)
    }

    private struct IndexFile: Codable {
        var schemaVersion: Int
        var rows: [ProjectIndexRow]
    }

    private static func readIndex() -> IndexFile? {
        guard let data = try? Data(contentsOf: indexURL),
              let index = try? JSONDecoder().decode(IndexFile.self, from: data),
              index.schemaVersion == currentIndexSchemaVersion else { return nil }
        return index
    }

    private static func writeIndex(_ rows: [ProjectIndexRow]) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
        guard let data = try? encoder.encode(IndexFile(schemaVersion: currentIndexSchemaVersion, rows: rows))
        else { return }
        try? FileManager.default.createDirectory(at: ProjectStore.projectsRoot,
                                                 withIntermediateDirectories: true)
        try? data.write(to: indexURL, options: [.atomic])
    }

    // MARK: Mutations

    /// Renames a project: the title lives in `project.json` (the source of
    /// truth), so the rename is written through the store and the index row is
    /// rebuilt from the saved project.
    static func rename(projectID: UUID, to newTitle: String) throws {
        var project = try ProjectStore.load(projectID)
        project.name = newTitle
        try ProjectStore.save(project)
        _ = loadRows()
    }

    /// Deletes a project directory permanently and drops its index row.
    /// Returns the number of bytes freed (the project's copied media included).
    @discardableResult
    static func delete(projectID: UUID) throws -> Int64 {
        let freed = directorySize(projectID)
        try FileManager.default.removeItem(at: ProjectStore.projectDirectory(projectID))
        if lastOpenedProjectID() == projectID { setLastOpenedProjectID(nil) }
        writeIndex(loadRows().filter { $0.id != projectID })
        return freed
    }

    /// Total size of a project directory, media included (recursive).
    static func directorySize(_ projectID: UUID) -> Int64 {
        let root = ProjectStore.projectDirectory(projectID)
        guard let enumerator = FileManager.default.enumerator(
            at: root, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey]) else { return 0 }
        var total: Int64 = 0
        for case let url as URL in enumerator {
            if let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey]),
               values.isRegularFile == true, let size = values.fileSize {
                total += Int64(size)
            }
        }
        return total
    }

    /// Records that a project was opened just now (its index row only; the
    /// relaunch restore reads the id from `lastOpenedProjectID()`).
    static func markOpened(projectID: UUID, at date: Date = Date()) {
        var rows = loadRows()
        guard let index = rows.firstIndex(where: { $0.id == projectID }) else { return }
        rows[index].lastOpenedAt = date
        writeIndex(rows)
    }

    // MARK: Last-opened project (relaunch restore)

    private static let lastOpenedProjectIDKey = "projectLibrary.lastOpenedProjectID"

    static func lastOpenedProjectID() -> UUID? {
        UserDefaults.standard.string(forKey: lastOpenedProjectIDKey).flatMap { UUID(uuidString: $0) }
    }

    static func setLastOpenedProjectID(_ id: UUID?) {
        if let id {
            UserDefaults.standard.set(id.uuidString, forKey: lastOpenedProjectIDKey)
        } else {
            UserDefaults.standard.removeObject(forKey: lastOpenedProjectIDKey)
        }
    }

    // MARK: Covers

    static func coverURL(projectID: UUID) -> URL? {
        let url = ProjectStore.projectDirectory(projectID).appendingPathComponent(coverFilename)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    private static func coverExists(_ projectID: UUID) -> Bool {
        coverURL(projectID: projectID) != nil
    }

    /// Generates `cover.jpg` for a project that doesn't have one yet: a
    /// representative frame ~1/3 into its first video clip (the issue's rule of
    /// thumb), or the first clip's image itself for photo-based projects.
    /// Best-effort throughout — a project without a cover just shows the
    /// placeholder tile — and deliberately run when the library is shown rather
    /// than on the save path, so saving is never slowed or failed by it.
    static func generateCoverIfMissing(projectID: UUID) async {
        let coverURL = ProjectStore.projectDirectory(projectID).appendingPathComponent(coverFilename)
        guard !FileManager.default.fileExists(atPath: coverURL.path),
              let project = try? ProjectStore.load(projectID) else { return }
        for clip in project.videoClips {
            guard let asset = project.asset(clip.assetID) else { continue }
            let fileURL = NativeComposer.resolveAssetURL(asset, in: project)
            guard FileManager.default.fileExists(atPath: fileURL.path) else { continue }
            if asset.mediaType == .image {
                if let image = UIImage(contentsOfFile: fileURL.path),
                   let data = image.jpegData(compressionQuality: 0.7) {
                    try? data.write(to: coverURL, options: [.atomic])
                }
                return
            }
            guard asset.mediaType == .video else { continue }
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: fileURL))
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 640, height: 640)
            generator.requestedTimeToleranceBefore = CMTime(seconds: 0.25, preferredTimescale: 600)
            generator.requestedTimeToleranceAfter = CMTime(seconds: 0.25, preferredTimescale: 600)
            let time = CMTimeAdd(clip.sourceStart.cmTime,
                                 CMTime(seconds: max(0, clip.sourceDuration.seconds) / 3,
                                        preferredTimescale: 600))
            if let cgImage = try? await generator.image(at: time).image,
               let data = UIImage(cgImage: cgImage).jpegData(compressionQuality: 0.7) {
                try? data.write(to: coverURL, options: [.atomic])
            }
            return
        }
    }

    // MARK: Sectioning + formatting (pure; the list renders exactly this)

    /// Buckets rows chat-app style: Pinned first, then Today / Yesterday /
    /// Previous 7 Days / Previous 30 Days by last-edit time, then one section
    /// per older month, newest first. Archived rows are excluded (their view
    /// arrives with Archive in Phase 3). Input order (newest edit first) is
    /// preserved inside every bucket.
    static func sections(from rows: [ProjectIndexRow], now: Date = Date(),
                         calendar: Calendar = .current) -> [ProjectLibrarySection] {
        let visible = rows.filter { !$0.isArchived }
        var result: [ProjectLibrarySection] = []
        let pinned = visible.filter { $0.isPinned }
        if !pinned.isEmpty { result.append(ProjectLibrarySection(title: "Pinned", rows: pinned)) }
        let rest = visible.filter { !$0.isPinned }

        let startToday = calendar.startOfDay(for: now)
        let startYesterday = calendar.date(byAdding: .day, value: -1, to: startToday) ?? startToday
        let startWeek = calendar.date(byAdding: .day, value: -7, to: startToday) ?? startYesterday
        let startMonth = calendar.date(byAdding: .day, value: -30, to: startToday) ?? startWeek

        let buckets: [(title: String, rows: [ProjectIndexRow])] = [
            ("Today", rest.filter { $0.updatedAt >= startToday }),
            ("Yesterday", rest.filter { $0.updatedAt >= startYesterday && $0.updatedAt < startToday }),
            ("Previous 7 Days", rest.filter { $0.updatedAt >= startWeek && $0.updatedAt < startYesterday }),
            ("Previous 30 Days", rest.filter { $0.updatedAt >= startMonth && $0.updatedAt < startWeek }),
        ]
        for bucket in buckets where !bucket.rows.isEmpty {
            result.append(ProjectLibrarySection(title: bucket.title, rows: bucket.rows))
        }

        let older = rest.filter { $0.updatedAt < startMonth }
        if !older.isEmpty {
            let formatter = DateFormatter()
            formatter.calendar = calendar
            formatter.dateFormat = "MMMM yyyy"
            var months: [(key: String, rows: [ProjectIndexRow])] = []
            for row in older {
                let key = formatter.string(from: row.updatedAt)
                if let index = months.firstIndex(where: { $0.key == key }) {
                    months[index].rows.append(row)
                } else {
                    months.append((key, [row]))
                }
            }
            result.append(contentsOf: months.map { ProjectLibrarySection(title: $0.key, rows: $0.rows) })
        }
        return result
    }

    /// "Edited 2h ago" — compact relative edit time for a row's trailing edge.
    static func relativeEditDescription(for date: Date, now: Date = Date()) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        switch seconds {
        case ..<60:
            return "Edited just now"
        case ..<3600:
            return "Edited \(Int(seconds / 60))m ago"
        case ..<86400:
            return "Edited \(Int(seconds / 3600))h ago"
        case ..<604_800:
            return "Edited \(Int(seconds / 86400))d ago"
        default:
            let formatter = DateFormatter()
            formatter.dateStyle = .medium
            formatter.timeStyle = .none
            return "Edited \(formatter.string(from: date))"
        }
    }

    /// Row duration: "45s" under a minute, "1:05" above it.
    static func durationDescription(_ seconds: Double) -> String {
        let total = Int(seconds.rounded())
        guard total >= 60 else { return "\(total)s" }
        return "\(total / 60):\(String(format: "%02d", total % 60))"
    }
}
