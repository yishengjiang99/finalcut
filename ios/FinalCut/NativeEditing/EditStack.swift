import Foundation

/// One applied edit.
struct EditEntry: Identifiable, Equatable, Sendable {
    let id: UUID
    var tool: String
    var op: NativeOp
    var toolCallId: String?
    var executedOn: ClientToolResult.ExecutedOn

    init(id: UUID = UUID(), tool: String, op: NativeOp, toolCallId: String? = nil, executedOn: ClientToolResult.ExecutedOn = .device) {
        self.id = id
        self.tool = tool
        self.op = op
        self.toolCallId = toolCallId
        self.executedOn = executedOn
    }
}

/// Non-destructive edit stack: the base file is never modified; the preview is composed
/// from `base` + `entries` and a file is written only on export.
struct EditStack: Equatable, Sendable {
    var base: URL
    var baseCanvas: NativeCanvas
    var entries: [EditEntry] = []
    /// Multi-clip timeline project (Timeline/EditorProject.swift), once the session has
    /// been upgraded by an import of additional media or a timeline tool. Single-clip
    /// sessions leave this nil and behave exactly as before.
    var project: EditorProject?
    /// History of project states for undo/redo of timeline commands (value snapshots of
    /// the project only — never media files).
    var projectHistory = ProjectHistory()

    /// True when preview/export must be composed from `project`: more than one video
    /// clip, or any independent audio track. A one-clip project with no audio tracks
    /// keeps the original single-source composer path.
    var isTimelineProject: Bool {
        guard let project else { return false }
        return project.videoClips.count > 1 || !project.audioTracks.isEmpty
    }
    /// Pre-cloud states (cloud steps flatten the stack into a new base).
    var history: [HistoryState] = []
    /// States undone since the last new edit, most recent last (Redo pops from here).
    private(set) var redoStates: [Snapshot] = []

    /// Everything Undo/Redo swaps (the redo list itself excluded).
    struct Snapshot: Equatable, Sendable {
        var base: URL
        var baseCanvas: NativeCanvas
        var entries: [EditEntry]
        var history: [HistoryState]
        var project: EditorProject?
        var projectHistory: ProjectHistory
    }

    private var snapshot: Snapshot {
        Snapshot(base: base, baseCanvas: baseCanvas, entries: entries, history: history,
                 project: project, projectHistory: projectHistory)
    }

    private mutating func restore(_ state: Snapshot) {
        base = state.base
        baseCanvas = state.baseCanvas
        entries = state.entries
        history = state.history
        project = state.project
        projectHistory = state.projectHistory
    }

    struct HistoryState: Equatable, Sendable {
        var base: URL
        var baseCanvas: NativeCanvas
        var entries: [EditEntry]
    }

    var isPhoto: Bool { baseCanvas.isPhoto }
    var ops: [NativeOp] { entries.map(\.op) }

    /// Canvas after every edit (what the user sees).
    var canvas: NativeCanvas {
        entries.reduce(baseCanvas) { $0.applying($1.op) }
    }

    /// The active YouTube soundtrack edit, if any (the latest one wins, like captions).
    var soundtrack: (file: URL, startOffset: Double, originalVolume: Double)? {
        for entry in entries.reversed() {
            if case .soundtrack(let file, let startOffset, let originalVolume) = entry.op {
                return (file, startOffset, originalVolume)
            }
        }
        return nil
    }

    /// Last requested container/format (`mp4`/`mov` for video, `jpg`/`png` for photos).
    var outputFormat: String? {
        for entry in entries.reversed() {
            if case .outputFormat(let f) = entry.op { return f }
        }
        return nil
    }

    /// A new edit. Clears Redo.
    mutating func push(_ entry: EditEntry) {
        entries.append(entry)
        redoStates.removeAll()
    }

    /// Removes the last edit (or restores the pre-cloud state when the stack is empty).
    /// The undone state can be brought back with `redo()` until the next new edit.
    @discardableResult
    mutating func undo() -> Bool {
        let current = snapshot
        if !entries.isEmpty {
            entries.removeLast()
        } else if let previous = history.popLast() {
            base = previous.base
            baseCanvas = previous.baseCanvas
            entries = previous.entries
        } else if let currentProject = project, let restored = projectHistory.undo(current: currentProject) {
            project = restored
        } else {
            return false
        }
        redoStates.append(current)
        return true
    }

    /// Re-applies the most recently undone step.
    @discardableResult
    mutating func redo() -> Bool {
        guard let next = redoStates.popLast() else { return false }
        restore(next)
        return true
    }

    /// A cloud step's result becomes the new base; the old state stays in history for undo.
    mutating func rebase(onto url: URL, canvas: NativeCanvas) {
        history.append(HistoryState(base: base, baseCanvas: baseCanvas, entries: entries))
        base = url
        baseCanvas = canvas
        entries = []
        redoStates.removeAll()
    }

    var canUndo: Bool { !entries.isEmpty || !history.isEmpty || projectHistory.canUndo }
    var canRedo: Bool { !redoStates.isEmpty }

    /// Runs one timeline command through the shared command layer (the same executor the
    /// timeline UI and the AI tools use), recording the pre-change project for undo.
    /// The caller is responsible for having materialised `project` (see
    /// `EditStackProjectAdapter.makeProject`); a failed command changes nothing.
    @discardableResult
    mutating func performProjectCommand(_ command: ProjectCommand) throws -> ProjectCommandResult {
        guard var working = project else { throw ProjectCommandError.invalid("no_project") }
        let before = working
        let result = try ProjectCommandExecutor.apply(command, to: &working)
        projectHistory.record(before: before)
        project = working
        redoStates.removeAll()
        return result
    }

    /// Index of the latest captions entry (`generate_captions` or `lyric_captions`); the latest wins.
    private var latestCaptionIndex: Int? {
        entries.lastIndex { entry in
            switch entry.op {
            case .captions, .lyricCaptions: return true
            default: return false
            }
        }
    }

    /// Burned-in captions on the final timeline: the latest captions entry, remapped through
    /// any trims/speed changes made after it. Empty when the latest captions are lyric captions.
    var captionCues: [CaptionCue] {
        guard let index = latestCaptionIndex, case .captions(var cues) = entries[index].op else { return [] }
        for entry in entries[(index + 1)...] {
            switch entry.op {
            case .trim(let start, let end): cues = CaptionFormatter.trimmed(cues, start: start, end: end)
            case .speed(let factor): cues = CaptionFormatter.sped(cues, factor: factor)
            default: break
            }
        }
        return cues
    }

    /// Lyric captions on the final timeline (when they are the latest captions), remapped the same way.
    var lyricTrack: LyricCaptionTrack? {
        guard let index = latestCaptionIndex, case .lyricCaptions(var track) = entries[index].op else { return nil }
        for entry in entries[(index + 1)...] {
            switch entry.op {
            case .trim(let start, let end): track = track.trimmed(start: start, end: end)
            case .speed(let factor): track = track.sped(factor: factor)
            default: break
            }
        }
        return track
    }
}
