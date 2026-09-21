import Foundation

struct APIConfig: Equatable {
    /// Default production API host.
    static let defaultBaseURL = URL(string: "https://grepawk.com")!

    var baseURL: URL

    /// When true (DEBUG / demo only), attach `sample-access-token` header.
    var sampleModeEnabled: Bool

    init(
        baseURL: URL = APIConfig.defaultBaseURL,
        sampleModeEnabled: Bool = false
    ) {
        self.baseURL = baseURL
        self.sampleModeEnabled = sampleModeEnabled
    }

    static var shared = APIConfig()
}
