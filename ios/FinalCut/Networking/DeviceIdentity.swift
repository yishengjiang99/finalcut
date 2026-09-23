import Foundation
import Security

/// Stable per-install identifier. This is intentionally not a hardware identifier.
enum DeviceIdentity {
    private static let service = "com.ragnus.w2.finalcut.device"
    private static let account = "install-id"

    static var installID: String {
        if let existing = read() { return existing }
        let value = UUID().uuidString.lowercased()
        save(value)
        return value
    }

    static var installUUID: UUID {
        UUID(uuidString: installID) ?? UUID()
    }

    private static func read() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func save(_ value: String) {
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
        ]
        SecItemAdd(query as CFDictionary, nil)
    }
}
