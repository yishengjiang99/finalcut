import Foundation

/// Phase 2 of the project library (issue #125): the model-facing "wire"
/// conversation of a project, persisted separately from the display-only
/// `[ChatMessage]` transcript.
///
/// The server is stateless: every `/api/chat` request carries the whole
/// conversation. Until now the client started each turn with only the new
/// user message, so the model had no memory of earlier turns — restoring the
/// on-screen transcript restored display only. The wire turns are the actual
/// messages exchanged with the model (user / assistant incl. tool calls /
/// tool results); saving them per project (`wire-turns.json`, next to
/// `project.json`) lets a reopened project continue where it left off.
///
/// Two policies apply when saved turns are restored into a new session:
/// - Budget: the restored context is capped at `tokenBudget` estimated
///   tokens; the oldest turns are pruned first and a turn is never split, so
///   a tool call is never separated from its result.
/// - Staleness: a prior session's tool results are not replayed as if they
///   described the current project state. Each restored tool result's payload
///   is replaced by a compact marker (see `sanitizedForRestore`); user and
///   assistant turns are restored verbatim.
enum WireTurns {
    /// Estimated-token ceiling for restored context. The estimate is
    /// char-based (see `estimatedTokens(of:)`) — there is no on-device
    /// tokenizer — at 4 chars/token over each message's compact JSON, the
    /// standard rough heuristic for English text and JSON payloads.
    static let tokenBudget = 24_000
    static let charsPerToken = 4

    /// Rough token estimate for one wire message: its compact JSON length
    /// divided by `charsPerToken`, rounded up, minimum 1.
    static func estimatedTokens(of message: JSONValue) -> Int {
        max(1, (message.jsonString().count + charsPerToken - 1) / charsPerToken)
    }

    static func estimatedTokens(of messages: [JSONValue]) -> Int {
        messages.reduce(0) { $0 + estimatedTokens(of: $1) }
    }

    /// Splits a conversation into turns: a user message plus everything that
    /// follows it, up to the next user message. Any messages before the first
    /// user message form a leading group of their own.
    static func turns(of messages: [JSONValue]) -> [[JSONValue]] {
        var groups: [[JSONValue]] = []
        for message in messages {
            if message["role"]?.stringValue == "user" || groups.isEmpty {
                groups.append([message])
            } else {
                groups[groups.count - 1].append(message)
            }
        }
        return groups
    }

    /// Drops the oldest turns until the estimate fits `budget`. The most
    /// recent turn is always kept whole, even if it alone exceeds the budget:
    /// recent context is the part a follow-up edit depends on.
    static func prunedToBudget(_ messages: [JSONValue], budget: Int = tokenBudget) -> [JSONValue] {
        var groups = turns(of: messages)
        var total = estimatedTokens(of: messages)
        while groups.count > 1, total > budget {
            total -= estimatedTokens(of: groups.removeFirst())
        }
        return groups.flatMap { $0 }
    }

    /// Replaces every tool result's payload with a stale marker, keeping the
    /// message's `tool_call_id` (so it still answers the assistant's tool
    /// call) and recording the tool's name, looked up from the assistant turn
    /// that issued the call. The original `ok` outcome is kept so the model
    /// knows whether the action succeeded. User and assistant messages pass
    /// through unchanged, and existing markers are left as-is, so sanitising
    /// is idempotent.
    static func sanitizedForRestore(_ messages: [JSONValue]) -> [JSONValue] {
        var toolNames: [String: String] = [:]
        for message in messages {
            guard message["role"]?.stringValue == "assistant",
                  let calls = message["tool_calls"]?.arrayValue else { continue }
            for call in calls {
                if let id = call["id"]?.stringValue, let name = call["function"]?["name"]?.stringValue {
                    toolNames[id] = name
                }
            }
        }
        return messages.map { message in
            guard message["role"]?.stringValue == "tool",
                  let callID = message["tool_call_id"]?.stringValue,
                  let content = message["content"]?.objectValue,
                  content["stale"]?.boolValue != true else { return message }
            var marker: [String: JSONValue] = [
                "ok": .bool(content["ok"]?.boolValue ?? true),
                "stale": .bool(true),
                "note": .string("Completed in a previous session; the result is not replayed."),
            ]
            if let name = toolNames[callID] { marker["tool"] = .string(name) }
            return .object([
                "role": .string("tool"),
                "tool_call_id": .string(callID),
                "content": .object(marker),
            ])
        }
    }

    /// The context a reopened project seeds its next chat turn with: stale
    /// tool results replaced by markers, then pruned to the token budget.
    static func restoredContext(from messages: [JSONValue]) -> [JSONValue] {
        prunedToBudget(sanitizedForRestore(messages))
    }
}

/// On-disk form of `wire-turns.json`: a version stamp plus the wire messages
/// in conversation order. Kept separate from `project.json` so the project
/// model and the display transcript are untouched by context persistence.
struct WireTurnsFile: Codable, Equatable {
    static let currentVersion = 1
    var version: Int
    var messages: [JSONValue]
}

/// Persistence for a project's wire turns, mirroring `ProjectStore`'s layout:
/// `Projects/<project-id>/wire-turns.json`, written atomically. Saving is
/// best-effort — a failed save degrades to session-only context and never
/// breaks editing — and a missing or unreadable file is a no-op, so projects
/// saved before Phase 2 behave exactly as they always have.
enum WireTurnStore {
    static let fileName = "wire-turns.json"

    static func fileURL(_ projectID: UUID) -> URL {
        ProjectStore.projectDirectory(projectID).appendingPathComponent(fileName)
    }

    static func save(_ messages: [JSONValue], projectID: UUID) {
        do {
            try ProjectStore.ensureDirectories(projectID)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
            let data = try encoder.encode(WireTurnsFile(version: WireTurnsFile.currentVersion, messages: messages))
            try data.write(to: fileURL(projectID), options: [.atomic])
        } catch {
            // Best-effort by design (see type comment).
        }
    }

    /// The saved wire messages verbatim, or nil when the project has no
    /// (readable, supported-version) `wire-turns.json`.
    static func load(projectID: UUID) -> [JSONValue]? {
        guard let data = try? Data(contentsOf: fileURL(projectID)),
              let file = try? JSONDecoder().decode(WireTurnsFile.self, from: data),
              file.version <= WireTurnsFile.currentVersion else { return nil }
        return file.messages
    }

    /// The sanitised, budget-pruned context to seed a reopened project's
    /// session with; empty when the project has no saved wire turns.
    static func restoredContext(projectID: UUID) -> [JSONValue] {
        guard let messages = load(projectID: projectID) else { return [] }
        return WireTurns.restoredContext(from: messages)
    }
}
