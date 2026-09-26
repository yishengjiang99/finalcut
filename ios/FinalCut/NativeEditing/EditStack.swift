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

    mutating func push(_ entry: EditEntry) {
        entries.append(entry)
    }

    /// Removes the last edit (or restores the pre-cloud state when the stack is empty).
    @discardableResult
    mutating func undo() -> Bool {
        if !entries.isEmpty {
            entries.removeLast()
            return true
        }
        if let previous = history.popLast() {
            base = previous.base
            baseCanvas = previous.baseCanvas
            entries = previous.entries
            return true
        }
        return false
    }

    /// A cloud step's result becomes the new base; the old state stays in history for undo.
    mutating func rebase(onto url: URL, canvas: NativeCanvas) {
        history.append(HistoryState(base: base, baseCanvas: baseCanvas, entries: entries))
        base = url
        baseCanvas = canvas
        entries = []
    }

    var canUndo: Bool { !entries.isEmpty || !history.isEmpty }
}
