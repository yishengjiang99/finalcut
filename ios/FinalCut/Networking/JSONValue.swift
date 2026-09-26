import Foundation

/// Minimal JSON value used for tool-call arguments and for round-tripping the server's
/// `messages` array verbatim in `execution: "client"` mode.
enum JSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
        if let o = try? c.decode([String: JSONValue].self) { self = .object(o); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unsupported JSON value")
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n):
            if n.rounded() == n, abs(n) < 1e15 { try c.encode(Int64(n)) } else { try c.encode(n) }
        case .bool(let b): try c.encode(b)
        case .object(let o): try c.encode(o)
        case .array(let a): try c.encode(a)
        case .null: try c.encodeNil()
        }
    }

    subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    var isNull: Bool { if case .null = self { return true }; return false }

    /// Number, or a numeric string (the model sometimes quotes numbers).
    var doubleValue: Double? {
        switch self {
        case .number(let n): return n.isFinite ? n : nil
        case .string(let s):
            let t = s.trimmingCharacters(in: .whitespaces)
            guard !t.isEmpty, let d = Double(t), d.isFinite else { return nil }
            return d
        default: return nil
        }
    }

    var stringValue: String? {
        switch self {
        case .string(let s): return s
        case .number(let n):
            return n.rounded() == n ? String(Int64(n)) : String(n)
        default: return nil
        }
    }

    var boolValue: Bool? {
        switch self {
        case .bool(let b): return b
        case .string(let s): return ["true", "1", "yes"].contains(s.lowercased()) ? true : (["false", "0", "no"].contains(s.lowercased()) ? false : nil)
        case .number(let n): return n != 0
        default: return nil
        }
    }

    var objectValue: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }
    var arrayValue: [JSONValue]? { if case .array(let a) = self { return a }; return nil }

    /// Foundation representation (for `JSONSerialization` / multipart `args`).
    var foundationValue: Any {
        switch self {
        case .string(let s): return s
        case .number(let n): return n.rounded() == n && abs(n) < 1e15 ? (Int(n) as Any) : n
        case .bool(let b): return b
        case .object(let o): return o.mapValues { $0.foundationValue }
        case .array(let a): return a.map { $0.foundationValue }
        case .null: return NSNull()
        }
    }

    /// Compact JSON string (sorted keys, stable for tests).
    func jsonString() -> String {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? enc.encode(self) else { return "null" }
        return String(decoding: data, as: UTF8.self)
    }

    static func parse(_ string: String) -> JSONValue? {
        guard let data = string.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: data)
    }
}
