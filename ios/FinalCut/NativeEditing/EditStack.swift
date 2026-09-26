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
    }

    private var snapshot: Snapshot {
        Snapshot(base: base, baseCanvas: baseCanvas, entries: entries, history: history)
    }

    private mutating func restore(_ state: Snapshot) {
        base = state.base
        baseCanvas = state.baseCanvas
        entries = state.entries
        history = state.history
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

    var canUndo: Bool { !entries.isEmpty || !history.isEmpty }
    var canRedo: Bool { !redoStates.isEmpty }

    /// Burned-in captions on the final timeline: the latest captions entry, remapped through
    /// any trims/speed changes made after it.
    var captionCues: [CaptionCue] {
        guard let index = entries.lastIndex(where: { if case .captions = $0.op { return true }; return false }),
              case .captions(var cues) = entries[index].op else { return [] }
        for entry in entries[(index + 1)...] {
            switch entry.op {
            case .trim(let start, let end): cues = CaptionFormatter.trimmed(cues, start: start, end: end)
            case .speed(let factor): cues = CaptionFormatter.sped(cues, factor: factor)
            default: break
            }
        }
        return cues
    }
}
