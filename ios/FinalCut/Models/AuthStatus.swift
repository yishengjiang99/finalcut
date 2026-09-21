import Foundation

struct AuthUser: Codable, Equatable, Identifiable {
    /// Stable id when present; falls back to email for Identifiable.
    var id: String
    var email: String?
    var name: String?
    var picture: String?
    /// From mobile Google auth response (PR #46).
    var hasSubscription: Bool?

    enum CodingKeys: String, CodingKey {
        case id
        case email
        case name
        case picture
        case hasSubscription
        case _id
    }

    init(
        id: String,
        email: String? = nil,
        name: String? = nil,
        picture: String? = nil,
        hasSubscription: Bool? = nil
    ) {
        self.id = id
        self.email = email
        self.name = name
        self.picture = picture
        self.hasSubscription = hasSubscription
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        email = try c.decodeIfPresent(String.self, forKey: .email)
        name = try c.decodeIfPresent(String.self, forKey: .name)
        picture = try c.decodeIfPresent(String.self, forKey: .picture)
        hasSubscription = try c.decodeIfPresent(Bool.self, forKey: .hasSubscription)
        if let id = try c.decodeIfPresent(String.self, forKey: .id) {
            self.id = id
        } else if let id = try c.decodeIfPresent(String.self, forKey: ._id) {
            self.id = id
        } else if let email {
            self.id = email
        } else {
            self.id = "unknown"
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encodeIfPresent(email, forKey: .email)
        try c.encodeIfPresent(name, forKey: .name)
        try c.encodeIfPresent(picture, forKey: .picture)
        try c.encodeIfPresent(hasSubscription, forKey: .hasSubscription)
    }
}

struct AuthStatus: Codable, Equatable {
    var authenticated: Bool
    var user: AuthUser?
    /// Present when authenticated via Bearer (Backend PR #46): `"bearer"`.
    var authMethod: String?
}

struct SampleAccessTokenResponse: Codable, Equatable {
    var token: String
    var expiresInMs: Int
}

/// Response from POST /api/auth/mobile/google (Backend PR #46).
/// Body request: `{ "idToken": "..." }`
/// Response: `{ accessToken, expiresIn, tokenType, user }`
struct MobileGoogleAuthResponse: Codable, Equatable {
    var accessToken: String
    /// TTL in milliseconds (e.g. 2592000000 ≈ 30 days).
    var expiresIn: Int
    var tokenType: String?
    var user: AuthUser
}

struct MobileGoogleAuthRequest: Codable, Equatable {
    var idToken: String
}
