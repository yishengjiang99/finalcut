import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import FinalCut

/// Photo mode (NATIVE_EDIT_UX.md §7) + server error-code UX (§8, Backend #88 / Design #90).
final class PhotoModeTests: XCTestCase {

    // MARK: - Fixtures

    private var tempDir: URL!

    override func setUpWithError() throws {
        tempDir = FileManager.default.temporaryDirectory.appendingPathComponent("PhotoModeTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tempDir)
    }

    /// 40x20 image: left half red, right half blue.
    private func makeTwoToneImage() -> CGImage {
        let ctx = CGContext(
            data: nil, width: 40, height: 20, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        ctx.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: 20, height: 20))
        ctx.setFillColor(CGColor(red: 0, green: 0, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 20, y: 0, width: 20, height: 20))
        return ctx.makeImage()!
    }

    /// Writes the two-tone image as `type` with EXIF `orientation`. Returns nil if the
    /// encoder isn't available on this runtime.
    private func writeImage(_ name: String, type: UTType, orientation: Int) -> URL? {
        let url = tempDir.appendingPathComponent(name)
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, makeTwoToneImage(), [kCGImagePropertyOrientation: orientation] as CFDictionary)
        return CGImageDestinationFinalize(dest) ? url : nil
    }

    private func pixel(_ url: URL, x: Int, y: Int) throws -> (r: Int, g: Int, b: Int) {
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        let w = image.width, h = image.height
        var data = [UInt8](repeating: 0, count: w * h * 4)
        let ctx = try XCTUnwrap(CGContext(
            data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        let i = (y * w + x) * 4
        return (Int(data[i]), Int(data[i + 1]), Int(data[i + 2]))
    }

    private func requireHEIC(orientation: Int = 6, name: String = "IMG_0001.HEIC") throws -> URL {
        guard let url = writeImage(name, type: .heic, orientation: orientation) else {
            throw XCTSkip("HEIC encoder unavailable on this simulator runtime")
        }
        return url
    }

    // MARK: - HEIC → JPEG on device (never upload HEIC)

    func testHEICImportBecomesUprightJPEGAndKeepsOrientation() throws {
        let heic = try requireHEIC(orientation: 6)
        XCTAssertEqual(PhotoTranscoder.orientedPixelSize(of: heic)?.width, 20)

        let imported = try ImportedVideo.copy(from: heic, contentType: .heic)
        defer { try? FileManager.default.removeItem(at: imported.url.deletingLastPathComponent()) }

        XCTAssertTrue(imported.isPhoto)
        XCTAssertEqual(imported.url.pathExtension, "jpg")
        XCTAssertEqual(imported.mimeType, "image/jpeg")
        XCTAssertEqual(PhotoTranscoder.decodedType(of: imported.url), .jpeg)
        XCTAssertEqual(PhotoTranscoder.orientation(of: imported.url), 1)
        // Orientation 6 baked into the pixels: 40x20 landscape → 20x40 portrait.
        let size = try XCTUnwrap(PhotoTranscoder.orientedPixelSize(of: imported.url))
        XCTAssertEqual(size.width, 20)
        XCTAssertEqual(size.height, 40)
        // EXIF 6: the original left (red) column is the visual top.
        let top = try pixel(imported.url, x: 10, y: 3)
        let bottom = try pixel(imported.url, x: 10, y: 36)
        XCTAssertGreaterThan(top.r, 180); XCTAssertLessThan(top.b, 90)
        XCTAssertGreaterThan(bottom.b, 180); XCTAssertLessThan(bottom.r, 90)
        // No HEIC left behind in the import folder.
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: imported.url.deletingLastPathComponent().path)
        XCTAssertFalse(leftovers.contains { $0.lowercased().hasSuffix(".heic") })
    }

    func testUploadablePhotoIsNeverHEIC() throws {
        let heic = try requireHEIC(orientation: 1, name: "upload.heic")
        let upload = try PhotoTranscoder.uploadablePhoto(at: heic)
        XCTAssertEqual(MediaMIME.mimeType(for: upload), "image/jpeg")
        XCTAssertEqual(PhotoTranscoder.decodedType(of: upload), .jpeg)
        XCTAssertFalse(PhotoTranscoder.forbiddenUploadMIMEs.contains(MediaMIME.mimeType(for: upload)))
    }

    func testHEICBytesBehindJPGNameAreStillConverted() throws {
        let heic = try requireHEIC(orientation: 1, name: "disguised.heic")
        let disguised = tempDir.appendingPathComponent("disguised.jpg")
        try FileManager.default.moveItem(at: heic, to: disguised)
        XCTAssertTrue(PhotoTranscoder.needsNormalization(disguised))
        let upload = try PhotoTranscoder.uploadablePhoto(at: disguised)
        XCTAssertEqual(PhotoTranscoder.decodedType(of: upload), .jpeg)
    }

    func testUprightJPEGPassesThroughUnchanged() throws {
        let jpg = try XCTUnwrap(writeImage("photo.jpg", type: .jpeg, orientation: 1))
        let original = try Data(contentsOf: jpg)
        XCTAssertFalse(PhotoTranscoder.needsNormalization(jpg))
        let imported = try ImportedVideo.copy(from: jpg, contentType: .jpeg)
        defer { try? FileManager.default.removeItem(at: imported.url.deletingLastPathComponent()) }
        XCTAssertEqual(imported.url.lastPathComponent, "photo.jpg")
        XCTAssertEqual(try Data(contentsOf: imported.url), original)
    }

    func testRotatedJPEGGetsOrientationBakedIn() throws {
        let jpg = try XCTUnwrap(writeImage("rotated.JPG", type: .jpeg, orientation: 6))
        XCTAssertTrue(PhotoTranscoder.needsNormalization(jpg))
        let out = try PhotoTranscoder.normalizedPhoto(at: jpg)
        XCTAssertTrue(FileManager.default.fileExists(atPath: out.path))
        XCTAssertEqual(PhotoTranscoder.orientation(of: out), 1)
        XCTAssertEqual(PhotoTranscoder.orientedPixelSize(of: out)?.height, 40)
    }

    func testPNGStaysPNG() throws {
        let png = try XCTUnwrap(writeImage("shot.png", type: .png, orientation: 1))
        let imported = try ImportedVideo.copy(from: png, contentType: .png)
        defer { try? FileManager.default.removeItem(at: imported.url.deletingLastPathComponent()) }
        XCTAssertEqual(imported.mimeType, "image/png")
    }

    @MainActor
    func testUnreadablePhotoImportShowsImportStepErrorNotEditCard() async throws {
        let bad = tempDir.appendingPathComponent("broken.heic")
        try Data("not an image".utf8).write(to: bad)
        let model = EditorViewModel()
        await model.handleImport(.success([bad]))
        XCTAssertEqual(model.importError, "Couldn't open this photo. Try a different one.")
        XCTAssertEqual(model.state, .failed)
        XCTAssertNil(model.localVideoURL)
        XCTAssertFalse(model.messages.contains { $0.failureCard != nil })
    }

    // MARK: - Photo mode editor

    @MainActor
    func testPhotoModeChipsAndMedia() async throws {
        let jpg = try XCTUnwrap(writeImage("p.jpg", type: .jpeg, orientation: 1))
        let model = EditorViewModel()
        await model.handleImport(.success([jpg]))
        let url = try XCTUnwrap(model.localVideoURL)
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        XCTAssertTrue(model.isPhoto)
        XCTAssertNil(model.importError)
        XCTAssertEqual(model.sampleChips, ["Make it warm", "Black and white", "More contrast"])
        let media = await model.currentMedia()
        XCTAssertEqual(media?.type, "image")
    }

    func testPhotoChipsMapToCompleteToolCalls() {
        XCTAssertEqual(EditorRoute.route(for: "Make it warm"),
                       .tool(name: "apply_color_filter", arguments: ["filter": .string("warm")]))
        XCTAssertEqual(EditorRoute.route(for: "Black and white"),
                       .tool(name: "apply_color_filter", arguments: ["filter": .string("grayscale")]))
        XCTAssertEqual(EditorRoute.route(for: "More contrast"),
                       .tool(name: "adjust_contrast", arguments: ["contrast": .number(1.3)]))
        for chip in EditorRoute.photoChips {
            guard case .tool(let name, let args) = EditorRoute.route(for: chip) else {
                return XCTFail("\(chip) should be a tool shortcut")
            }
            XCTAssertTrue(ToolCatalog.missingRequiredArgs(tool: name, arguments: args).isEmpty, chip)
            if case .reject = ToolCatalog.plan(tool: name, arguments: args, isPhoto: true) {
                XCTFail("\(chip) must be allowed on photos")
            }
        }
        XCTAssertEqual(EditorRoute.chips(isPhoto: false), EditorRoute.sampleChips)
    }

    func testVideoOnlyToolsAreRejectedLocallyForPhotos() {
        XCTAssertEqual(
            ToolCatalog.plan(tool: "trim_video", arguments: ["start": .number(0), "end": .number(2)], isPhoto: true),
            .reject(error: "unsupported_for_photo")
        )
        XCTAssertEqual(ToolCatalog.plan(tool: "adjust_speed", arguments: ["speed": .number(2)], isPhoto: true),
                       .reject(error: "unsupported_for_photo"))
        XCTAssertEqual(ToolCatalog.plan(tool: "generate_captions", arguments: [:], isPhoto: true),
                       .reject(error: "unsupported_for_photo"))
        XCTAssertEqual(ToolCatalog.plan(tool: "apply_color_filter", arguments: ["filter": .string("warm")], isPhoto: true),
                       .serverJob(operation: "apply_color_filter", args: ["filter": .string("warm")]))
        XCTAssertEqual(ToolCatalog.plan(tool: "flip_video_vertical", arguments: [:], isPhoto: true),
                       .serverJob(operation: "flip_video_vertical", args: [:]))
        XCTAssertEqual(ToolCatalog.plan(tool: "get_video_dimensions", arguments: [:], isPhoto: true),
                       .localQuery(tool: "get_video_dimensions"))
        // Same tool on a video still runs.
        XCTAssertEqual(
            ToolCatalog.plan(tool: "trim_video", arguments: ["start": .number(0), "end": .number(2)]),
            .serverJob(operation: "trim_video", args: ["start": .number(0), "end": .number(2)])
        )
    }

    @MainActor
    func testVideoToolOnPhotoShowsCardWithoutRetryOrNetwork() async throws {
        let jpg = try XCTUnwrap(writeImage("q.jpg", type: .jpeg, orientation: 1))
        let model = EditorViewModel()
        model.localVideoURL = jpg
        let result = await model.executeToolCall(
            ClientToolCall(id: "c1", name: "trim_video", arguments: ["start": .number(0), "end": .number(1)])
        )
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.error, "unsupported_for_photo")
        XCTAssertEqual(result.executedOn, .device)
        let card = try XCTUnwrap(model.messages.last?.failureCard)
        XCTAssertEqual(card.kind, .photoUnsupported)
        XCTAssertEqual(model.messages.last?.content, "That works on videos, not photos.")
        XCTAssertFalse(card.showsRetry)
    }

    @MainActor
    func testCaptionsChipOnPhotoShowsPhotoUnsupportedCard() throws {
        let jpg = try XCTUnwrap(writeImage("r.jpg", type: .jpeg, orientation: 1))
        let model = EditorViewModel()
        model.localVideoURL = jpg
        model.state = .ready
        model.composerText = "Generate captions"
        model.sendMessage()
        XCTAssertEqual(model.state, .ready)
        XCTAssertEqual(model.messages.last?.failureCard?.kind, .photoUnsupported)
    }

    @MainActor
    func testMalformedArgumentsGoBackToModelAsInvalidArguments() async {
        let model = EditorViewModel()
        model.localVideoURL = Bundle.main.url(forResource: "finalcap-test-video", withExtension: "mp4")
        let json = #"{"id":"c9","name":"trim_video","arguments":"{not json"}"#
        let call = try? JSONDecoder().decode(ClientToolCall.self, from: Data(json.utf8))
        let result = await model.executeToolCall(try! XCTUnwrap(call))
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.error, "invalid_arguments")
        XCTAssertFalse(model.messages.contains { $0.failureCard != nil }, "card only at end of turn")
    }

    // MARK: - Error codes → UI (never raw text)

    func testCopyStringsMatchDesign() {
        XCTAssertEqual(EditFailureKind.photoUnsupported.copy, "That works on videos, not photos.")
        XCTAssertEqual(EditFailureKind.invalidArguments.copy, "Couldn't apply that edit. Try saying it another way.")
        XCTAssertEqual(EditFailureKind.generic.copy, "Something went wrong with that edit.")
        XCTAssertEqual(EditFailureKind.unsupportedImageFormat.copy, "Couldn't open this photo. Try a different one.")
        XCTAssertEqual(UXCopy.chooseAnother, "Choose another")
        XCTAssertEqual(UXCopy.exportPhotoTitle, "Save photo")
    }

    func testCodeMappingAndRetryRules() {
        XCTAssertEqual(EditFailureKind.from(code: "unsupported_for_photo"), .photoUnsupported)
        XCTAssertEqual(EditFailureKind.from(code: "invalid_arguments"), .invalidArguments)
        XCTAssertEqual(EditFailureKind.from(code: "unsupported_image_format"), .unsupportedImageFormat)
        XCTAssertEqual(EditFailureKind.from(code: "something_new"), .generic)
        XCTAssertEqual(EditFailureKind.from(code: nil), .generic)
        XCTAssertTrue(EditFailureKind.generic.allowsRetry)
        XCTAssertFalse(EditFailureKind.photoUnsupported.allowsRetry)
        XCTAssertFalse(EditFailureKind.invalidArguments.allowsRetry)
        XCTAssertFalse(EditFailureKind.unsupportedImageFormat.allowsRetry)
        XCTAssertEqual(EditFailureKind.invalidArguments.toolError, "invalid_arguments")
    }

    func testEndOfTurnCards() {
        var outcome = EditTurnOutcome()
        outcome.record(.failure("invalid_arguments", on: .server), kind: .invalidArguments)
        XCTAssertEqual(outcome.endOfTurnCard(prompt: "p"), EditFailureCard(kind: .invalidArguments))
        XCTAssertFalse(outcome.endOfTurnCard(prompt: "p")!.showsRetry)

        // Model corrected itself → no card.
        outcome.record(.success(on: .server), kind: nil)
        XCTAssertNil(outcome.endOfTurnCard(prompt: "p"))

        var generic = EditTurnOutcome()
        generic.record(.failure("edit_failed", on: .server), kind: .generic)
        let card = generic.endOfTurnCard(prompt: "make it red")
        XCTAssertEqual(card?.kind, .generic)
        XCTAssertEqual(card?.retryPrompt, "make it red")
        XCTAssertEqual(card?.showsRetry, true)

        var photo = EditTurnOutcome()
        photo.record(.failure("unsupported_for_photo", on: .server), kind: .photoUnsupported)
        XCTAssertNil(photo.endOfTurnCard(prompt: "p"), "photo card is shown immediately, not repeated")
    }

    func testSyncErrorBodiesMapByCodeAndHideRawText() {
        let photo = APIClient.error(forStatus: 400, data: Data(#"{"error":"Operation \"trim_video\" is not supported for photos.","code":"unsupported_for_photo","operation":"trim_video","mediaType":"image"}"#.utf8))
        XCTAssertEqual(photo.serverCode, "unsupported_for_photo")
        XCTAssertEqual(photo.serverFailureKind, .photoUnsupported)
        XCTAssertEqual(photo.errorDescription, "That works on videos, not photos.")

        let invalid = APIClient.error(forStatus: 400, data: Data(#"{"error":"trim_video requires a start","code":"invalid_arguments"}"#.utf8))
        XCTAssertEqual(invalid.serverFailureKind, .invalidArguments)

        let heic = APIClient.error(forStatus: 415, data: Data(#"{"error":"HEIC photos are not supported by this server","code":"unsupported_image_format","mediaType":"image","format":"heic"}"#.utf8))
        XCTAssertEqual(heic.serverFailureKind, .unsupportedImageFormat)

        let other = APIClient.error(forStatus: 500, data: Data(#"{"error":"ffmpeg exited with code 1: Invalid data found"}"#.utf8))
        XCTAssertEqual(other.serverFailureKind, .generic)
        XCTAssertFalse(other.errorDescription?.contains("ffmpeg") ?? true)
        XCTAssertFalse(other.errorDescription?.contains("500") ?? true)
        XCTAssertEqual(APIError.decoding.errorDescription, "Something went wrong with that edit.")
        XCTAssertEqual(APIError.paywallRequired("raw server text").errorDescription?.contains("raw"), false)
    }

    func testFailedJobPollDecodesCode() throws {
        let json = #"{"jobId":"j1","status":"failed","error":"HEIC photos are not supported by this server (…)","code":"unsupported_image_format","mediaType":"image","operation":"adjust_hue"}"#
        let poll = try JSONDecoder().decode(JobPollResponse.self, from: Data(json.utf8))
        XCTAssertEqual(poll.status, .failed)
        XCTAssertEqual(poll.code, "unsupported_image_format")
        XCTAssertEqual(EditFailureKind.from(code: poll.code), .unsupportedImageFormat)
        let noCode = try JSONDecoder().decode(JobPollResponse.self, from: Data(#"{"jobId":"j2","status":"failed","error":"boom"}"#.utf8))
        XCTAssertNil(noCode.code)
        XCTAssertEqual(EditFailureKind.from(code: noCode.code), .generic)
    }

    func testFailureCardMessageRoundTrips() throws {
        let message = ChatMessage.failure(EditFailureCard(kind: .generic, retryPrompt: "Red filter"))
        XCTAssertEqual(message.content, "Something went wrong with that edit.")
        let decoded = try JSONDecoder().decode(ChatMessage.self, from: JSONEncoder().encode(message))
        XCTAssertEqual(decoded, message)
    }

    @MainActor
    func testRetryResendsPromptOnlyForGenericCards() throws {
        let model = EditorViewModel()
        model.localVideoURL = Bundle.main.url(forResource: "finalcap-test-video", withExtension: "mp4")
        model.state = .ready
        model.retry(EditFailureCard(kind: .photoUnsupported, retryPrompt: "x"))
        XCTAssertTrue(model.messages.isEmpty)
        model.retry(EditFailureCard(kind: .generic, retryPrompt: "Red filter"))
        XCTAssertEqual(model.messages.first?.role, .user)
        XCTAssertEqual(model.messages.first?.content, "Red filter")
    }

    // MARK: - Export

    func testSavePhotoKeepsOriginalFormat() {
        XCTAssertEqual(PhotoLibrarySaver.resourceOptions(for: URL(fileURLWithPath: "/t/a.jpg")).uniformTypeIdentifier, UTType.jpeg.identifier)
        XCTAssertEqual(PhotoLibrarySaver.resourceOptions(for: URL(fileURLWithPath: "/t/a.png")).uniformTypeIdentifier, UTType.png.identifier)
    }
}
