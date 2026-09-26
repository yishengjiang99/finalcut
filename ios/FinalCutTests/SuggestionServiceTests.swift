import UIKit
import XCTest
@testable import FinalCut

/// Stubbed network for the suggestions endpoint.
final class SuggestionStubProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (Int, Data))?
    nonisolated(unsafe) static var requests: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet)); return
        }
        do {
            let (status, data) = try handler(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}
}

final class SuggestionServiceTests: XCTestCase {
    private var defaults: UserDefaults!
    private var clock = Date(timeIntervalSince1970: 1_800_000_000)

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: "SuggestionServiceTests-\(UUID().uuidString)")
        SuggestionStubProtocol.handler = nil
        SuggestionStubProtocol.requests = []
    }

    private func service() -> SuggestionService {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SuggestionStubProtocol.self]
        return SuggestionService(session: URLSession(configuration: configuration), defaults: defaults,
                                 now: { [unowned self] in self.clock })
    }

    private let good = Data(#"""
    {"suggestions":[
      {"id":"vhs","label":"VHS look","prompt":"Give the video a retro VHS look.","icon":"not.a.real.symbol"},
      {"id":"bad","label":"Missing prompt"},
      {"id":"bw","label":"Black and white","prompt":"Make it black and white.","icon":7}
    ],"ttl":600}
    """#.utf8)

    func testGoodResponseIsUsedAndCached() async throws {
        SuggestionStubProtocol.handler = { _ in (200, self.good) }
        let pills = await service().suggestions(for: .video)
        XCTAssertEqual(pills.map(\.label), ["VHS look", "Black and white"], "bad entries are skipped")
        XCTAssertEqual(pills.first?.prompt, "Give the video a retro VHS look.")
        XCTAssertNil(pills.last?.icon, "non-string icon ignored")
        let request = try XCTUnwrap(SuggestionStubProtocol.requests.first)
        XCTAssertEqual(request.url?.path, "/api/ios/suggestions")
        let query = request.url?.query ?? ""
        XCTAssertTrue(query.contains("media=video"), query)
        XCTAssertTrue(query.contains("build="), query)
        XCTAssertTrue(request.value(forHTTPHeaderField: "User-Agent")?.hasPrefix("FinalCap-iOS/") == true)
        let cache = try XCTUnwrap(service().cached(.video))
        XCTAssertEqual(cache.ttl, 600)
        XCTAssertEqual(cache.suggestions, pills)

        // Within ttl: served from the cache, no request.
        SuggestionStubProtocol.requests = []
        let again = await service().suggestions(for: .video)
        XCTAssertEqual(again, pills)
        XCTAssertTrue(SuggestionStubProtocol.requests.isEmpty)
    }

    func testNotDeployed404FallsBackToBundled() async {
        SuggestionStubProtocol.handler = { _ in (404, Data("Not found".utf8)) }
        let video = await service().suggestions(for: .video)
        XCTAssertEqual(video, SuggestionService.bundledVideo)
        let photo = await service().suggestions(for: .photo)
        XCTAssertEqual(photo, SuggestionService.bundledPhoto)
        XCTAssertNil(service().cached(.video))
    }

    func testStaleCacheIsRefreshed() async {
        let old = [SuggestionPill(id: "old", label: "Old", prompt: "old prompt")]
        service().store(.init(fetchedAt: clock.addingTimeInterval(-7200), ttl: 3600, suggestions: old), for: .photo)
        SuggestionStubProtocol.handler = { _ in (200, self.good) }
        let pills = await service().suggestions(for: .photo)
        XCTAssertEqual(pills.map(\.id), ["vhs", "bw"])
        XCTAssertEqual(SuggestionStubProtocol.requests.count, 1)
        XCTAssertEqual(service().cached(.photo)?.fetchedAt, clock)
    }

    func testOfflineUsesTheCache() async {
        let cached = [SuggestionPill(id: "c", label: "Cached", prompt: "cached prompt")]
        service().store(.init(fetchedAt: clock.addingTimeInterval(-86_400), ttl: 3600, suggestions: cached), for: .video)
        SuggestionStubProtocol.handler = { _ in throw URLError(.notConnectedToInternet) }
        let pills = await service().suggestions(for: .video)
        XCTAssertEqual(pills, cached)
        XCTAssertEqual(service().immediate(for: .video), cached)
    }

    func testMissingTTLDefaultsAndEmptyListFallsBack() async {
        SuggestionStubProtocol.handler = { _ in (200, Data(#"{"suggestions":[{"id":"a","label":"A","prompt":"p"}]}"#.utf8)) }
        _ = await service().suggestions(for: .video)
        XCTAssertEqual(service().cached(.video)?.ttl, SuggestionService.defaultTTL)

        SuggestionStubProtocol.handler = { _ in (200, Data(#"{"suggestions":[]}"#.utf8)) }
        let photo = await service().suggestions(for: .photo)
        XCTAssertEqual(photo, SuggestionService.bundledPhoto, "never an empty row")
    }

    func testBundledDefaultsAreOnDeviceWork() {
        XCTAssertEqual(SuggestionService.bundledVideo.map(\.label),
                       ["Captions", "Trim to 15s", "Add a title", "Make it vertical", "Slow motion", "Speed up 2×", "Warmer look", "Mute audio"])
        XCTAssertEqual(SuggestionService.bundledPhoto.map(\.label),
                       ["Black and white", "Brighten", "More vivid", "Warmer look", "Square 1:1", "Add text"])
        XCTAssertEqual(SuggestionService.bundledVideo.map(\.id),
                       ["v-captions", "v-trim-15", "v-title", "v-vertical", "v-slowmo", "v-speed-2x", "v-warm", "v-mute"])
        XCTAssertEqual(SuggestionService.bundledPhoto.map(\.id),
                       ["p-bw", "p-brighten", "p-vivid", "p-warm", "p-square", "p-text"])
        for pill in SuggestionService.bundledVideo + SuggestionService.bundledPhoto {
            XCTAssertGreaterThan(pill.prompt.count, pill.label.count, pill.label)
            XCTAssertNotNil(UIImage(systemName: pill.icon ?? ""), "\(pill.id) icon")
        }
    }
}
