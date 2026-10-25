import Foundation

/// In-house funnel telemetry → POST https://photo.grepawk.com/api/telemetry.
/// Mirrors the ProTune iOS client (photo-recipes `Analytics`): persisted per-install
/// `anon_id`, a session that rotates after 30 minutes idle, and `app_version`/`build`
/// on every event. Fire-and-forget: transport errors are swallowed, nothing is
/// retried, and the UI never waits on it.
/// Never send prompts, chat text, media, file names or tokens — kinds and ids only.
final class Telemetry {
    static let shared = Telemetry()

    /// Telemetry lives on the photo-recipes host (shared `telemetry_events` table),
    /// not on the app's own API host. Events are tagged `app: "finalcap"`.
    private static let endpoint = URL(string: "https://photo.grepawk.com/api/telemetry")!
    private static let app = "finalcap"

    private let anonKey = "telemetry.anonId"
    private let sessionKey = "telemetry.sessionId"
    private let sessionTsKey = "telemetry.sessionTs"
    private let sessionTTL: TimeInterval = 30 * 60

    /// Prop keys that must never leave the device (user content carriers).
    private static let droppedKeys: Set<String> = [
        "prompt", "text", "message", "email", "phone", "token", "password",
        "filename", "file_name", "path", "url", "image", "photo", "base64", "gps",
    ]

    private let session: URLSession
    /// Serializes sends so a burst of events leaves in order, one at a time.
    private let sendQueue = DispatchQueue(label: "com.ragnus.finalcap.telemetry")

    init(session: URLSession = .shared) {
        self.session = session
    }

    var anonId: String {
        let existing = UserDefaults.standard.string(forKey: anonKey)
        if let existing, existing.count >= 8 { return existing }
        let id = UUID().uuidString
        UserDefaults.standard.set(id, forKey: anonKey)
        return id
    }

    var sessionId: String {
        let now = Date().timeIntervalSince1970
        let prev = UserDefaults.standard.double(forKey: sessionTsKey)
        var sid = UserDefaults.standard.string(forKey: sessionKey)
        if sid == nil || prev == 0 || now - prev > sessionTTL {
            sid = UUID().uuidString
            UserDefaults.standard.set(sid, forKey: sessionKey)
        }
        UserDefaults.standard.set(now, forKey: sessionTsKey)
        return sid ?? UUID().uuidString
    }

    static let baseProps: [String: Any] = {
        let info = Bundle.main.infoDictionary
        return [
            "app_version": info?["CFBundleShortVersionString"] as? String ?? "unknown",
            "build": info?["CFBundleVersion"] as? String ?? "unknown",
        ]
    }()

    func track(_ event: String, props: [String: Any] = [:]) {
        // Event contract: every event carries app_version + build so journeys
        // reconstruct by version. Explicit props win.
        var merged = Self.baseProps
        for (k, v) in props { merged[k] = v }
        var cleaned: [String: Any] = [:]
        for (k, v) in merged {
            if Self.droppedKeys.contains(k.lowercased()) { continue }
            switch v {
            case let s as String:
                cleaned[k] = String(s.prefix(200))
            case let b as Bool:
                cleaned[k] = b
            case let n as NSNumber:
                cleaned[k] = n
            default:
                continue
            }
        }
        let body: [String: Any] = [
            "event": event,
            "anon_id": anonId,
            "session_id": sessionId,
            "platform": "ios",
            "app": Self.app,
            "props": cleaned,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        var request = URLRequest(url: Self.endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        request.timeoutInterval = 10
        let session = self.session
        sendQueue.async {
            session.dataTask(with: request) { _, _, _ in
                // Fire-and-forget: 202 expected; any outcome is ignored.
            }.resume()
        }
    }
}
