import Foundation

// `POST /api/chat` with `execution: "client"` — see docs/api/CLIENT_TOOL_EXECUTION.md.
// The server plans tool calls; the app executes them and posts results back until `status: "final"`.

struct ClientMedia: Codable, Equatable {
    var type: String
    var duration: Double?
    var width: Int?
    var height: Int?
    var fps: Double?
    var hasAudio: Bool?
}

struct ClientChatRequest: Encodable {
    var execution = "client"
    var messages: [JSONValue]
    var media: ClientMedia?
    var thumbnails: [String]?
}

struct ClientToolCall: Decodable, Equatable {
    var id: String
    var name: String
    var arguments: [String: JSONValue]
    var argumentsError: String?

    enum CodingKeys: String, CodingKey { case id, name, arguments, argumentsError }

    init(id: String, name: String, arguments: [String: JSONValue], argumentsError: String? = nil) {
        self.id = id
        self.name = name
        self.arguments = arguments
        self.argumentsError = argumentsError
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        argumentsError = try c.decodeIfPresent(String.self, forKey: .argumentsError)
        // Accept an object (contract) or a JSON string (OpenAI shape).
        if let object = try? c.decode([String: JSONValue].self, forKey: .arguments) {
            arguments = object
        } else if let string = try? c.decode(String.self, forKey: .arguments),
                  let parsed = JSONValue.parse(string)?.objectValue {
            arguments = parsed
        } else {
            arguments = [:]
        }
    }
}

struct ClientChatResponse: Decodable {
    var schemaVersion: String?
    var status: String
    var toolCalls: [ClientToolCall]
    var messages: [JSONValue]?
    var finalText: String?
    var round: Int?
    var maxRounds: Int?

    enum CodingKeys: String, CodingKey {
        case schemaVersion, status, toolCalls, messages, message, content, text, round, maxRounds
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try c.decodeIfPresent(String.self, forKey: .schemaVersion)
        status = try c.decode(String.self, forKey: .status)
        toolCalls = try c.decodeIfPresent([ClientToolCall].self, forKey: .toolCalls) ?? []
        messages = try c.decodeIfPresent([JSONValue].self, forKey: .messages)
        round = try c.decodeIfPresent(Int.self, forKey: .round)
        maxRounds = try c.decodeIfPresent(Int.self, forKey: .maxRounds)
        if let text = try? c.decode(String.self, forKey: .message) {
            finalText = text
        } else if let obj = try? c.decode(JSONValue.self, forKey: .message), let text = obj["content"]?.stringValue {
            finalText = text
        } else {
            finalText = (try? c.decode(String.self, forKey: .content)) ?? (try? c.decode(String.self, forKey: .text))
        }
    }
}

/// Tool result sent back as `{ role: "tool", tool_call_id, content: { ok, error?, executedOn, output? } }`.
struct ClientToolResult: Equatable {
    enum ExecutedOn: String { case device, server }

    var ok: Bool
    var error: String?
    var executedOn: ExecutedOn
    var output: [String: JSONValue]?

    static func success(on executedOn: ExecutedOn, output: [String: JSONValue]? = nil) -> ClientToolResult {
        ClientToolResult(ok: true, error: nil, executedOn: executedOn, output: output)
    }

    static func failure(_ error: String, on executedOn: ExecutedOn) -> ClientToolResult {
        ClientToolResult(ok: false, error: error, executedOn: executedOn, output: nil)
    }

    var content: JSONValue {
        var object: [String: JSONValue] = ["ok": .bool(ok), "executedOn": .string(executedOn.rawValue)]
        if let error {
            // `error` is always a stable code; `code` mirrors it for the server contract
            // (e.g. {ok:false, error:"unsupported_on_device", code:"unsupported_on_device", executedOn:"device"}).
            object["error"] = .string(error)
            object["code"] = .string(error)
        }
        if let output { object["output"] = .object(output) }
        return .object(object)
    }

    func toolMessage(callId: String) -> JSONValue {
        .object([
            "role": .string("tool"),
            "tool_call_id": .string(callId),
            "content": content,
        ])
    }
}

enum ClientChat {
    static func userMessage(_ text: String) -> JSONValue {
        .object(["role": .string("user"), "content": .string(text)])
    }

    /// Assistant turn carrying tool calls, used only if the server omits `messages`.
    static func assistantToolCallsMessage(_ calls: [ClientToolCall]) -> JSONValue {
        .object([
            "role": .string("assistant"),
            "content": .null,
            "tool_calls": .array(calls.map { call in
                .object([
                    "id": .string(call.id),
                    "type": .string("function"),
                    "function": .object([
                        "name": .string(call.name),
                        "arguments": .string(JSONValue.object(call.arguments).jsonString()),
                    ]),
                ])
            }),
        ])
    }

    /// Next request's messages: the server's echoed conversation (or ours + the assistant
    /// tool-call turn) followed by one tool message per call, in call order.
    static func continuation(
        previous: [JSONValue],
        response: ClientChatResponse,
        results: [(callId: String, result: ClientToolResult)]
    ) -> [JSONValue] {
        var next = response.messages ?? (previous + [assistantToolCallsMessage(response.toolCalls)])
        for item in results {
            next.append(item.result.toolMessage(callId: item.callId))
        }
        return next
    }
}
