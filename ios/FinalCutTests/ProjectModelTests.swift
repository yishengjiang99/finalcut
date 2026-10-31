import CoreMedia
import Foundation
import XCTest
@testable import FinalCut

/// Phase A model tests: exact CMTime storage, derived layout/duration, validation,
/// and the source ↔ clip ↔ project caption mapping.
final class ProjectModelTests: XCTestCase {
    private func asset(_ name: String, seconds: Double, width: Double = 1920, height: Double = 1080, audio: Bool = true) -> MediaAsset {
        MediaAsset(id: UUID(), relativePath: "Media/\(name)", name: name, mediaType: .video,
                   duration: .seconds(seconds), naturalSize: CodableSize(width: width, height: height),
                   preferredTransform: .identity, nominalFrameRate: 30, hasAudio: audio)
    }

    private func projectWithClips(_ specs: [(asset: MediaAsset, start: Double, end: Double, speed: Double)]) -> EditorProject {
        var project = EditorProject(name: "T", canvas: ProjectCanvas(width: 1920, height: 1080))
        project.assets = specs.map(\.asset)
        project.videoClips = specs.map {
            VideoClip(id: UUID(), assetID: $0.asset.id, sourceStart: .seconds($0.start), sourceEnd: .seconds($0.end), speed: $0.speed)
        }
        return project
    }

    func testCodableTimeIsExactAndRoundTrips() throws {
        let time = CodableTime(CMTime(value: 123_457, timescale: 600))
        let data = try JSONEncoder().encode(time)
        let decoded = try JSONDecoder().decode(CodableTime.self, from: data)
        XCTAssertEqual(decoded, time)
        XCTAssertEqual(decoded.cmTime.value, 123_457)
        XCTAssertEqual(decoded.cmTime.timescale, 600)
    }

    func testProjectJSONRoundTripPreservesTimeline() throws {
        var project = projectWithClips([(asset("a.mov", seconds: 10), 1, 9, 2), (asset("b.mov", seconds: 8), 0, 8, 1)])
        project.audioTracks = [AudioTrack(id: UUID(), name: "Music", kind: .music, clips: [
            AudioClip(id: UUID(), assetID: project.assets[0].id, sourceStart: .zero, sourceDuration: .seconds(30),
                      timelineStart: .seconds(2), gain: 0.2, loop: true, repeatUntil: .seconds(20)),
        ])]
        let data = try JSONEncoder().encode(project)
        let decoded = try JSONDecoder().decode(EditorProject.self, from: data)
        XCTAssertEqual(decoded, project)
        XCTAssertEqual(decoded.durationSeconds, project.durationSeconds, accuracy: 0.001)
    }

    func testDurationIsDerivedFromArrangement() {
        // 8s at 2x (=4s) + 8s at 1x = 12s.
        let project = projectWithClips([(asset("a.mov", seconds: 10), 1, 9, 2), (asset("b.mov", seconds: 8), 0, 8, 1)])
        XCTAssertEqual(project.durationSeconds, 12, accuracy: 0.001)
        XCTAssertEqual(project.layout.map { $0.start.seconds }, [0, 4])
    }

    func testTransitionOverlapShortensDuration() {
        var project = projectWithClips([(asset("a.mov", seconds: 10), 0, 10, 1), (asset("b.mov", seconds: 10), 0, 10, 1)])
        project.videoClips[0].transitionOut = TransitionSpec(kind: .crossDissolve, duration: .seconds(1))
        XCTAssertEqual(project.durationSeconds, 19, accuracy: 0.001)
        XCTAssertEqual(project.layout[1].start.seconds, 9, accuracy: 0.001)
        // Overlap clamps to half the shorter neighbour.
        project.videoClips[0].transitionOut = TransitionSpec(kind: .crossDissolve, duration: .seconds(30))
        XCTAssertEqual(project.transitionOverlap(after: 0).seconds, 5, accuracy: 0.001)
    }

    func testValidationCatchesBadRangesAndMissingAssets() {
        var project = projectWithClips([(asset("a.mov", seconds: 10), 0, 12, 1)])
        XCTAssertTrue(project.validationIssues().contains("clip_range_exceeds_asset"))
        project.videoClips[0].sourceEnd = .seconds(9)
        project.videoClips[0].assetID = UUID()
        XCTAssertTrue(project.validationIssues().contains("clip_missing_asset"))
        // Valid speeds are 0.05...16 (same contract as ProjectCommand's set speed), so 9x is
        // legal; use values outside the range on both ends.
        project.videoClips[0].speed = 9
        XCTAssertFalse(project.validationIssues().contains("clip_speed_out_of_range"))
        project.videoClips[0].speed = 32
        XCTAssertTrue(project.validationIssues().contains("clip_speed_out_of_range"))
        project.videoClips[0].speed = 0.01
        XCTAssertTrue(project.validationIssues().contains("clip_speed_out_of_range"))
    }

    func testSourceTimeMappingThroughTrimAndSpeed() {
        let project = projectWithClips([(asset("a.mov", seconds: 20), 5, 15, 2)])
        // Project 2.5s in = local 2.5 * speed 2 = source 5 + 5 = 10s.
        let mapped = project.sourceTime(atProjectTime: CMTime(seconds: 2.5, preferredTimescale: 600))
        XCTAssertEqual(mapped?.sourceTime.seconds ?? -1, 10, accuracy: 0.001)
        XCTAssertNil(project.sourceTime(atProjectTime: CMTime(seconds: 99, preferredTimescale: 600)))
    }

    func testPerClipCaptionsMapToProjectTimeAndFollowReorder() throws {
        var beach = asset("beach.mov", seconds: 10)
        beach.id = UUID()
        var dinner = asset("dinner.mov", seconds: 12)
        dinner.id = UUID()
        var project = EditorProject(name: "T", canvas: .hd1080Landscape)
        project.assets = [beach, dinner]
        var dinnerClip = VideoClip(id: UUID(), assetID: dinner.id, sourceStart: .seconds(2), sourceEnd: .seconds(12), speed: 2)
        dinnerClip.captions = [CaptionCue(start: 4, end: 6, text: "cheers")]
        project.videoClips = [
            VideoClip(id: UUID(), assetID: beach.id, sourceStart: .zero, sourceEnd: .seconds(10)),
            dinnerClip,
        ]
        // Dinner starts at project 10; cue source 4-6 -> local (4-2)/2=1 to (6-2)/2=2 -> project 11-12.
        var cues = project.projectCaptions()
        XCTAssertEqual(cues.count, 1)
        XCTAssertEqual(cues[0].start, 11, accuracy: 0.001)
        XCTAssertEqual(cues[0].end, 12, accuracy: 0.001)
        // Reorder: dinner first -> cue moves to 1-2s. No duplication, no loss.
        try ProjectCommandExecutor.apply(.reorderVideoClips(orderedIDs: [dinnerClip.id, project.videoClips[0].id]), to: &project)
        cues = project.projectCaptions()
        XCTAssertEqual(cues.count, 1)
        XCTAssertEqual(cues[0].start, 1, accuracy: 0.001)
    }

    // MARK: - Wire turns (Phase 2, #125): saved model context per project

    private func withTemporaryProjectStore(_ body: () throws -> Void) throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("fc-wire-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        ProjectStore.baseDirectoryOverride = base
        defer {
            ProjectStore.baseDirectoryOverride = nil
            try? FileManager.default.removeItem(at: base)
        }
        try body()
    }

    /// One wire tool exchange: the assistant's tool-call message + its result.
    private func wireToolTurn(callID: String, name: String, output: String) -> [JSONValue] {
        let call = ClientToolCall(id: callID, name: name, arguments: [:])
        let result = ClientToolResult.success(on: .device, output: ["detail": .string(output)])
        return [ClientChat.assistantToolCallsMessage([call]), result.toolMessage(callId: callID)]
    }

    private func finalResponse(messages: [JSONValue]?, finalText: String?) -> ClientChatResponse {
        var object: [String: JSONValue] = ["status": .string("final"), "toolCalls": .array([])]
        if let messages { object["messages"] = .array(messages) }
        if let finalText { object["message"] = .string(finalText) }
        let data = try! JSONEncoder().encode(JSONValue.object(object))
        return try! JSONDecoder().decode(ClientChatResponse.self, from: data)
    }

    func testWireTurnsSaveLoadRoundTrip() throws {
        try withTemporaryProjectStore {
            let projectID = UUID()
            let messages: [JSONValue] = [ClientChat.userMessage("trim it")]
                + wireToolTurn(callID: "c1", name: "trim_video", output: "done")
                + [ClientChat.assistantMessage("Trimmed.")]
            WireTurnStore.save(messages, projectID: projectID)
            XCTAssertTrue(FileManager.default.fileExists(atPath: WireTurnStore.fileURL(projectID).path))
            XCTAssertEqual(WireTurnStore.load(projectID: projectID), messages)
            // Kept separate from the project file: wire turns never create one.
            XCTAssertFalse(FileManager.default.fileExists(atPath: ProjectStore.projectFileURL(projectID).path))
        }
    }

    func testWireTurnsMissingFileIsNoOp() throws {
        try withTemporaryProjectStore {
            let projectID = UUID()
            XCTAssertNil(WireTurnStore.load(projectID: projectID))
            XCTAssertEqual(WireTurnStore.restoredContext(projectID: projectID), [])
        }
    }

    func testWireTurnsRestoreSanitizesStaleToolResults() {
        let messages: [JSONValue] = [ClientChat.userMessage("make it warmer")]
            + wireToolTurn(callID: "c1", name: "set_color", output: "big payload")
            + [ClientChat.assistantMessage("Done — warmed it up.")]
        let restored = WireTurns.restoredContext(from: messages)
        XCTAssertEqual(restored.count, messages.count)
        XCTAssertEqual(restored[0], messages[0]) // user turn intact
        XCTAssertEqual(restored[1], messages[1]) // assistant tool-call turn intact
        XCTAssertEqual(restored[3], messages[3]) // assistant text intact
        let tool = restored[2]
        XCTAssertEqual(tool["tool_call_id"]?.stringValue, "c1")
        let content = tool["content"]?.objectValue
        XCTAssertEqual(content?["stale"]?.boolValue, true)
        XCTAssertEqual(content?["tool"]?.stringValue, "set_color")
        XCTAssertEqual(content?["ok"]?.boolValue, true)
        XCTAssertNil(content?["output"]) // the stale payload itself is gone
        XCTAssertNotNil(content?["note"]?.stringValue)
        // Sanitising is idempotent: a marker survives a second pass unchanged.
        XCTAssertEqual(WireTurns.sanitizedForRestore(restored), restored)
    }

    func testWireTurnsRestorePrunesOldestTurnsToBudget() {
        var messages: [JSONValue] = []
        for index in 0..<6 {
            messages.append(ClientChat.userMessage("turn \(index) " + String(repeating: "x", count: 400)))
            messages += wireToolTurn(callID: "c\(index)", name: "trim_video", output: "ok")
            messages.append(ClientChat.assistantMessage("done \(index)"))
        }
        let sanitized = WireTurns.sanitizedForRestore(messages)
        let budget = WireTurns.estimatedTokens(of: sanitized) / 2
        let restored = WireTurns.prunedToBudget(sanitized, budget: budget)
        XCTAssertLessThanOrEqual(WireTurns.estimatedTokens(of: restored), budget)
        // Starts on a user message, so no tool result is orphaned at the head…
        XCTAssertEqual(restored.first?["role"]?.stringValue, "user")
        // …the oldest turn is gone…
        XCTAssertFalse(restored.contains(ClientChat.userMessage("turn 0 " + String(repeating: "x", count: 400))))
        // …and the most recent turn survives whole.
        XCTAssertEqual(Array(restored.suffix(4)), Array(sanitized.suffix(4)))
        // No orphaned tool results anywhere: each answers a call still present.
        var callIDs = Set<String>()
        for message in restored {
            if let calls = message["tool_calls"]?.arrayValue {
                for call in calls {
                    if let id = call["id"]?.stringValue { callIDs.insert(id) }
                }
            }
            if message["role"]?.stringValue == "tool", let id = message["tool_call_id"]?.stringValue {
                XCTAssertTrue(callIDs.contains(id), "tool result \(id) lost its call")
            }
        }
    }

    func testCompletedTurnMessagesUsesEchoDelta() {
        let seed: [JSONValue] = [ClientChat.userMessage("first"), ClientChat.assistantMessage("ok")]
        let turn: [JSONValue] = [ClientChat.userMessage("second")]
            + wireToolTurn(callID: "c9", name: "trim_video", output: "done")
            + [ClientChat.assistantMessage("All set.")]
        let response = finalResponse(messages: seed + turn, finalText: "All set.")
        let delta = ClientChat.completedTurnMessages(seed: seed, previous: seed + Array(turn.dropLast()), response: response)
        XCTAssertEqual(delta, turn)
    }

    func testCompletedTurnMessagesFallsBackToLocalChain() {
        let seed: [JSONValue] = [ClientChat.userMessage("first"), ClientChat.assistantMessage("ok")]
        let previous: [JSONValue] = seed + [ClientChat.userMessage("second")]
            + wireToolTurn(callID: "c9", name: "trim_video", output: "done")
        let response = finalResponse(messages: nil, finalText: "All set.")
        let delta = ClientChat.completedTurnMessages(seed: seed, previous: previous, response: response)
        XCTAssertEqual(delta, Array(previous.dropFirst(seed.count)) + [ClientChat.assistantMessage("All set.")])
    }

    // MARK: Transcript persistence (Phase 2, #125)

    func testTranscriptSaveLoadRoundTrip() throws {
        try withTemporaryProjectStore {
            let projectID = UUID()
            try ProjectStore.ensureDirectories(projectID)
            let dir = ProjectStore.projectDirectory(projectID)
            let inside = dir.appendingPathComponent("Media/thumb.jpg")
            let outside = FileManager.default.temporaryDirectory.appendingPathComponent("elsewhere.jpg")
            let chip = CaptionDownloadChip(label: "SRT", filename: "captions.srt", content: "1")
            let messages = [
                ChatMessage(role: .system, content: "Opened Untitled (1 clips)."),
                ChatMessage(role: .user, content: "trim it"),
                ChatMessage(role: .assistant, content: "Trimmed.", resultThumbnailURLs: [inside, outside], downloadChips: [chip]),
            ]
            TranscriptStore.save(messages, projectID: projectID)
            let loaded = try XCTUnwrap(TranscriptStore.load(projectID: projectID))
            // System status lines are session-only; ids/content/chips survive.
            XCTAssertEqual(loaded.map(\.id), [messages[1].id, messages[2].id])
            XCTAssertEqual(loaded.map(\.content), ["trim it", "Trimmed."])
            XCTAssertEqual(loaded[1].downloadChips, [chip])
            // Thumbnails are stored project-relative; ones outside the project are dropped.
            XCTAssertEqual(loaded[1].resultThumbnailURLs.map(\.standardizedFileURL), [inside.standardizedFileURL])
            let raw = try String(contentsOf: TranscriptStore.fileURL(projectID), encoding: .utf8)
            XCTAssertTrue(raw.contains("thumb.jpg"))
            XCTAssertFalse(raw.contains(dir.lastPathComponent), "no absolute paths on disk")
        }
    }

    func testTranscriptMissingOrCorruptFileLoadsNil() throws {
        try withTemporaryProjectStore {
            let projectID = UUID()
            XCTAssertNil(TranscriptStore.load(projectID: projectID))
            // No project directory: save is a no-op (never resurrects a deleted project).
            TranscriptStore.save([ChatMessage(role: .user, content: "hi")], projectID: projectID)
            XCTAssertFalse(FileManager.default.fileExists(atPath: ProjectStore.projectDirectory(projectID).path))
            try ProjectStore.ensureDirectories(projectID)
            try Data("{not json".utf8).write(to: TranscriptStore.fileURL(projectID))
            XCTAssertNil(TranscriptStore.load(projectID: projectID))
            try Data(#"{"version": 99, "messages": []}"#.utf8).write(to: TranscriptStore.fileURL(projectID))
            XCTAssertNil(TranscriptStore.load(projectID: projectID))
        }
    }

    // MARK: Title flag (Phase 2, #125)

    func testAutoTitleNeverOverwritesUserEditedTitle() {
        var project = EditorProject(canvas: .hd1080Landscape)
        XCTAssertTrue(project.applyAutoTitle(from: "  make it   black and white  "))
        XCTAssertEqual(project.name, "make it black and white")
        // Already titled: a later prompt doesn't re-title.
        XCTAssertFalse(project.applyAutoTitle(from: "add captions"))
        XCTAssertEqual(project.name, "make it black and white")

        var renamed = EditorProject(canvas: .hd1080Landscape)
        renamed.setUserTitle(EditorProject.defaultName) // user picked "Untitled" on purpose
        XCTAssertEqual(renamed.titleIsUserEdited, true)
        XCTAssertFalse(renamed.applyAutoTitle(from: "trim the intro"))
        XCTAssertEqual(renamed.name, EditorProject.defaultName)

        XCTAssertNil(EditorProject.autoTitle(from: "   "))
        let long = EditorProject.autoTitle(from: String(repeating: "word ", count: 30))!
        XCTAssertLessThanOrEqual(long.count, EditorProject.autoTitleMaxLength)
        XCTAssertTrue(long.hasSuffix("…"))
    }

    func testTitleFlagIsBackwardCompatibleAndPersists() throws {
        var project = EditorProject(name: "Trip", canvas: .hd1080Landscape)
        // A project.json saved before the flag existed has no such key.
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(project)) as? [String: Any])
        json.removeValue(forKey: "titleIsUserEdited")
        let legacy = try JSONDecoder().decode(EditorProject.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertNil(legacy.titleIsUserEdited)
        XCTAssertEqual(legacy.name, "Trip")

        project.setUserTitle("My trip")
        let decoded = try JSONDecoder().decode(EditorProject.self, from: JSONEncoder().encode(project))
        XCTAssertEqual(decoded.titleIsUserEdited, true)
        XCTAssertEqual(decoded, project)
    }

    // MARK: Library search / pin / archive (Phase 3, #125)

    private var utcCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private func libraryRow(_ title: String, _ updated: Date, pinned: Bool = false, archived: Bool = false) -> ProjectIndexRow {
        ProjectIndexRow(id: UUID(), title: title, createdAt: updated, updatedAt: updated, lastOpenedAt: nil,
                        durationSeconds: 5, clipCount: 1, audioClipCount: 0, coverFilename: nil,
                        isPinned: pinned, isArchived: archived, projectFileModifiedAt: updated)
    }

    func testLibraryBucketsFilterAndSort() {
        let now = utcCalendar.date(from: DateComponents(year: 2026, month: 10, day: 31, hour: 12))!
        let pinnedBeach = libraryRow("Beach Trip", now.addingTimeInterval(-3600), pinned: true)
        let dinner = libraryRow("dinner", now.addingTimeInterval(-2 * 3600))
        let hotel = libraryRow("Hotel", now.addingTimeInterval(-26 * 3600))
        let archivedPinned = libraryRow("beach reel", now.addingTimeInterval(-3 * 3600), pinned: true, archived: true)
        let oldBeach = libraryRow("Old BEACH", utcCalendar.date(from: DateComponents(year: 2026, month: 9, day: 15))!, archived: true)
        let rows = [oldBeach, hotel, archivedPinned, dinner, pinnedBeach] // unsorted on purpose
        func ids(_ query: String) -> [[UUID]] {
            let b = ProjectLibrary.buckets(from: rows, query: query, now: now, calendar: utcCalendar)
            return [b.pinned.map(\.id), b.projects.map(\.id), b.archived.map(\.id)]
        }
        // Archived rows only in the archived bucket (even when pinned); newest edit first.
        XCTAssertEqual(ids(""), [[pinnedBeach.id], [dinner.id, hotel.id], [archivedPinned.id, oldBeach.id]])
        // Case-insensitive title match.
        XCTAssertEqual(ids("  BeAcH "), [[pinnedBeach.id], [], [archivedPinned.id, oldBeach.id]])
        // Date labels match too.
        XCTAssertEqual(ids("yesterday"), [[], [hotel.id], []])
        XCTAssertEqual(ids("TODAY"), [[pinnedBeach.id], [dinner.id], [archivedPinned.id]])
        XCTAssertEqual(ids("september 2026"), [[], [], [oldBeach.id]])
        XCTAssertEqual(ids("no such project"), [[], [], []])
    }

    func testPinAndArchivePersistAndOldFilesLoad() throws {
        // project.json from before Phase 3 has no pin/archive keys.
        let project = EditorProject(name: "Trip", canvas: .hd1080Landscape)
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(project)) as? [String: Any])
        json.removeValue(forKey: "isPinned")
        json.removeValue(forKey: "isArchived")
        let legacy = try JSONDecoder().decode(EditorProject.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertNil(legacy.isPinned)
        XCTAssertNil(legacy.isArchived)

        try withTemporaryProjectStore {
            try ProjectStore.save(project)
            let fileURL = ProjectStore.projectFileURL(project.id)
            let before = try XCTUnwrap(ProjectLibrary.loadRows().first)
            XCTAssertFalse(before.isPinned)

            try ProjectLibrary.setPinned(projectID: project.id, true)
            try ProjectLibrary.setArchived(projectID: project.id, true)
            let saved = try ProjectStore.load(project.id)
            XCTAssertEqual(saved.isPinned, true)
            XCTAssertEqual(saved.isArchived, true)
            let row = try XCTUnwrap(ProjectLibrary.loadRows().first)
            XCTAssertTrue(row.isPinned)
            XCTAssertTrue(row.isArchived)
            // Not an edit: last-edited time is unchanged.
            XCTAssertEqual(row.updatedAt.timeIntervalSince(before.updatedAt), 0, accuracy: 0.001)
            let mtime = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: fileURL.path)[.modificationDate] as? Date)
            XCTAssertEqual(mtime.timeIntervalSince(before.projectFileModifiedAt), 0, accuracy: 0.001)

            // A rebuilt index (deleted cache) still knows the flags from project.json.
            try FileManager.default.removeItem(at: ProjectStore.projectsRoot.appendingPathComponent("index.json"))
            let rebuilt = try XCTUnwrap(ProjectLibrary.loadRows().first)
            XCTAssertTrue(rebuilt.isPinned)
            XCTAssertTrue(rebuilt.isArchived)
        }
    }

    func testArchiveUndoRestoresTheRow() throws {
        try withTemporaryProjectStore {
            let project = EditorProject(name: "Trip", canvas: .hd1080Landscape)
            try ProjectStore.save(project)
            let before = ProjectLibrary.buckets(from: ProjectLibrary.loadRows())
            XCTAssertEqual(before.projects.map(\.id), [project.id])

            try ProjectLibrary.setArchived(projectID: project.id, true)
            let archived = ProjectLibrary.buckets(from: ProjectLibrary.loadRows())
            XCTAssertEqual(archived.projects, [])
            XCTAssertEqual(archived.archived.map(\.id), [project.id])

            try ProjectLibrary.setArchived(projectID: project.id, false) // Undo toast
            let after = ProjectLibrary.buckets(from: ProjectLibrary.loadRows())
            XCTAssertEqual(after.projects.map(\.id), [project.id])
            XCTAssertEqual(after.archived, [])
            XCTAssertNil(try ProjectStore.load(project.id).isArchived)
        }
    }

    @MainActor
    func testAnyEditUnarchivesTheOpenProject() throws {
        try withTemporaryProjectStore {
            let model = EditorViewModel()
            var stack = EditStack(base: URL(fileURLWithPath: "/tmp/base.mov"),
                                  baseCanvas: NativeCanvas(width: 1280, height: 720, duration: 6, isPhoto: false, hasAudio: true))
            stack.project = stack.makeProject()
            stack.project?.isArchived = true
            model.editStack = stack
            XCTAssertTrue(model.isOpenProjectArchived)

            var edited = stack
            edited.push(EditEntry(tool: "apply_color_filter", op: .colorFilter(filter: "red", intensity: 1)))
            model.commitEdit(edited)
            XCTAssertFalse(model.isOpenProjectArchived)
            let id = try XCTUnwrap(model.timelineProject?.id)
            XCTAssertNil(try ProjectStore.load(id).isArchived) // persisted
        }
    }

    func testAutoTitleTruncationEdgeCases() {
        let max = EditorProject.autoTitleMaxLength
        // First line only, trimmed.
        XCTAssertEqual(EditorProject.autoTitle(from: "\n\n  Make it pop  \nand add music"), "Make it pop")
        // Exactly at the limit: unchanged, no ellipsis.
        let exact = String(repeating: "a", count: max)
        XCTAssertEqual(EditorProject.autoTitle(from: exact), exact)
        // Over the limit: cut at a word boundary, ellipsis added, never over the limit.
        let words = "Trim the intro then add warm color grading and upbeat music"
        let cut = try! XCTUnwrap(EditorProject.autoTitle(from: words))
        XCTAssertEqual(cut, "Trim the intro then add warm color…")
        XCTAssertLessThanOrEqual(cut.count, max)
        XCTAssertTrue(words.hasPrefix(String(cut.dropLast())))
        // One long word: hard cut.
        let long = try! XCTUnwrap(EditorProject.autoTitle(from: String(repeating: "x", count: 100)))
        XCTAssertEqual(long.count, max)
        XCTAssertTrue(long.hasSuffix("…"))
        // Whitespace-only / empty: no title.
        XCTAssertNil(EditorProject.autoTitle(from: " \n\t "))
        XCTAssertNil(EditorProject.autoTitle(from: ""))
        // No prompt yet: "Untitled · <date>", which auto-title may replace.
        var project = EditorProject(canvas: .hd1080Landscape)
        XCTAssertTrue(project.name.hasPrefix("Untitled · "))
        XCTAssertTrue(project.hasPlaceholderTitle)
        XCTAssertTrue(project.applyAutoTitle(from: "color grade"))
        XCTAssertEqual(project.name, "color grade")
        // User-edited titles are never overridden, even a placeholder-looking one.
        var edited = EditorProject(canvas: .hd1080Landscape)
        edited.setUserTitle("Untitled · mine")
        XCTAssertFalse(edited.applyAutoTitle(from: "color grade"))
        XCTAssertEqual(edited.name, "Untitled · mine")
    }
}
