import Foundation

/// Undo/redo for project mutations. Snapshots are value-type `EditorProject`s — they hold
/// asset IDs and relative paths only, never media bytes, so a deep history is cheap.
/// `ProjectCommandExecutor` stays the only mutator; history just records the states
/// around it (record the pre-change project, push the result as the new current state).
struct ProjectHistory: Equatable, Sendable {
    static let limit = 100

    private(set) var undoStack: [EditorProject] = []
    private(set) var redoStack: [EditorProject] = []

    var canUndo: Bool { !undoStack.isEmpty }
    var canRedo: Bool { !redoStack.isEmpty }

    /// Call with the project as it was BEFORE a successful command.
    mutating func record(before: EditorProject) {
        undoStack.append(before)
        if undoStack.count > Self.limit { undoStack.removeFirst(undoStack.count - Self.limit) }
        redoStack.removeAll()
    }

    /// Returns the project to restore, or nil when there is nothing to undo.
    mutating func undo(current: EditorProject) -> EditorProject? {
        guard let previous = undoStack.popLast() else { return nil }
        redoStack.append(current)
        return previous
    }

    mutating func redo(current: EditorProject) -> EditorProject? {
        guard let next = redoStack.popLast() else { return nil }
        undoStack.append(current)
        return next
    }

    mutating func clear() {
        undoStack.removeAll()
        redoStack.removeAll()
    }
}

/// Applies commands to a project with history, so the UI's undo button, shake-to-undo
/// and the AI tools all share one undo contract.
struct ProjectSession: Equatable, Sendable {
    var project: EditorProject
    var history = ProjectHistory()

    init(project: EditorProject) { self.project = project }

    var canUndo: Bool { history.canUndo }
    var canRedo: Bool { history.canRedo }
    var durationSeconds: Double { project.durationSeconds }

    @discardableResult
    mutating func perform(_ command: ProjectCommand) throws -> ProjectCommandResult {
        let before = project
        let result = try ProjectCommandExecutor.apply(command, to: &project)
        history.record(before: before)
        return result
    }

    @discardableResult
    mutating func undo() -> Bool {
        guard let restored = history.undo(current: project) else { return false }
        project = restored
        return true
    }

    @discardableResult
    mutating func redo() -> Bool {
        guard let restored = history.redo(current: project) else { return false }
        project = restored
        return true
    }
}
