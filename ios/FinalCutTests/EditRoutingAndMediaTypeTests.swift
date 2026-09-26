import UniformTypeIdentifiers
import XCTest
@testable import FinalCut

/// Build-8 hotfix: free text goes to the server chat (no local trim_video fallback),
/// uploads carry the real MIME type, and results keep the server's extension.
final class EditRoutingAndMediaTypeTests: XCTestCase {

    // MARK: - Routing

    func testFreeTextGoesToServerChatNotALocalTool() {
        XCTAssertEqual(EditorRoute.route(for: "make it red"), .chat("make it red"))
        XCTAssertEqual(EditorRoute.route(for: "  Make it RED  "), .chat("Make it RED"))
        XCTAssertEqual(EditorRoute.route(for: "speed it up 2x"), .chat("speed it up 2x"))
        XCTAssertEqual(EditorRoute.route(for: "trim to the first 5 seconds"), .chat("trim to the first 5 seconds"))
        XCTAssertEqual(EditorRoute.route(for: "add captions please"), .chat("add captions please"))
    }

    func testChipShortcutsMapToCorrectToolsWithCompleteArgs() {
        XCTAssertEqual(
            EditorRoute.route(for: "Red filter"),
            .tool(name: "apply_color_filter", arguments: ["filter": .string("red")])
        )
        // Gap tools never get a chip shortcut: free text goes to the model.
        XCTAssertEqual(EditorRoute.route(for: "Trim silence"), .chat("Trim silence"))
        XCTAssertEqual(EditorRoute.route(for: "Generate captions"), .chat("Generate captions"))
        XCTAssertEqual(EditorRoute.route(for: "Translate to Spanish"), .captions(.translate(language: "Spanish")))
        XCTAssertEqual(EditorRoute.route(for: "Burn in"), .captions(.burnIn))
    }

    func testVideoChipsMatchDesignAndAllRunOnDevice() {
        XCTAssertEqual(EditorRoute.designVideoChips,
                       ["Generate captions", "Red filter", "Speed up 2×", "Add a title", "Fade out audio"])
        let expected = EditorRoute.onDeviceCaptionsAvailable
            ? EditorRoute.designVideoChips
            : ["Red filter", "Speed up 2×", "Add a title", "Fade out audio"]
        XCTAssertEqual(EditorRoute.chips(isPhoto: false), expected)
        for chip in ["Translate to Spanish", "Burn in", "Trim silence"] {
            XCTAssertFalse(EditorRoute.chips(isPhoto: false).contains(chip))
            XCTAssertFalse(EditorRoute.chips(isPhoto: true).contains(chip))
        }

        let video = NativeCanvas(width: 1280, height: 720, duration: 6, isPhoto: false, hasAudio: true)
        let photo = NativeCanvas(width: 1280, height: 720, duration: 0, isPhoto: true, hasAudio: false)
        let all = EditorRoute.chips(isPhoto: false).map { ($0, video) } + EditorRoute.chips(isPhoto: true).map { ($0, photo) }
        for (chip, canvas) in all {
            switch EditorRoute.route(for: chip) {
            case .tool(let name, let arguments):
                XCTAssertTrue(NativeToolParser.isSupported(name), "\(chip) → \(name) is not native")
                guard case .success(.apply) = NativeToolParser.plan(tool: name, arguments: arguments, canvas: canvas) else {
                    return XCTFail("\(chip) → \(name) doesn't plan natively")
                }
            case .chat(let prompt) where prompt == "Generate captions":
                // The model calls generate_captions, which must run on the device.
                XCTAssertTrue(EditorRoute.onDeviceCaptionsAvailable, "\(chip) needs on-device captions")
                XCTAssertTrue(NativeToolParser.isSupported("generate_captions"))
                guard case .success(.captions) = NativeToolParser.plan(tool: "generate_captions", arguments: [:], canvas: canvas) else {
                    return XCTFail("generate_captions must plan on the device")
                }
            default:
                XCTFail("\(chip) must map to a native tool or on-device captions")
            }
        }
    }

    func testNoChipOrRouteProducesAToolWithMissingRequiredArgs() {
        let inputs = EditorRoute.sampleChips + ["make it red", "trim", "vertical crop", "", "speed", "crop it"]
        for input in inputs {
            if case .tool(let name, let arguments) = EditorRoute.route(for: input) {
                XCTAssertTrue(ToolCatalog.isKnown(name), "\(input) → unknown tool \(name)")
                XCTAssertEqual(ToolCatalog.missingRequiredArgs(tool: name, arguments: arguments), [], "\(input) → \(name) missing args")
                XCTAssertNotEqual(name, "trim_video", "\(input) must not map to trim_video")
            }
        }
    }

    func testTrimWithoutArgsIsRejectedAndNeverSentToServer() {
        XCTAssertEqual(ToolCatalog.missingRequiredArgs(tool: "trim_video", arguments: [:]), ["start", "end"])
        XCTAssertEqual(
            ToolCatalog.plan(tool: "trim_video", arguments: [:]),
            .reject(error: "missing_required_args: start, end")
        )
        XCTAssertEqual(
            ToolCatalog.plan(tool: "trim_video", arguments: ["start": .string("0"), "end": .null]),
            .reject(error: "missing_required_args: end")
        )
        XCTAssertEqual(
            ToolCatalog.plan(tool: "trim_video", arguments: ["start": .string(""), "end": .string("5")]),
            .reject(error: "missing_required_args: start")
        )
        XCTAssertEqual(
            ToolCatalog.plan(tool: "trim_video", arguments: ["start": .string("0"), "end": .string("5")]),
            .serverJob(operation: "trim_video", args: ["start": .string("0"), "end": .string("5")])
        )
    }

    func testRedFilterPlansApplyColorFilterJob() {
        XCTAssertEqual(
            ToolCatalog.plan(tool: "apply_color_filter", arguments: ["filter": .string("red")]),
            .serverJob(operation: "apply_color_filter", args: ["filter": .string("red")])
        )
        XCTAssertEqual(
            ToolCatalog.plan(tool: "apply_color_filter", arguments: [:]),
            .reject(error: "missing_required_args: filter")
        )
    }

    func testToolNamesMapToServerOperations() {
        XCTAssertEqual(
            ToolCatalog.plan(tool: "adjust_speed", arguments: ["speed": .number(2)]),
            .serverJob(operation: "speed_video", args: ["speed": .number(2)])
        )
        XCTAssertEqual(
            ToolCatalog.plan(tool: "adjust_audio_volume", arguments: ["volume": .number(0.5)]),
            .serverJob(operation: "adjust_volume", args: ["volume": .number(0.5)])
        )
        XCTAssertEqual(
            ToolCatalog.plan(tool: "resize_video_preset", arguments: ["preset": .string("9:16")]),
            .serverJob(operation: "resize_video", args: ["width": .number(1080), "height": .number(1920)])
        )
        XCTAssertEqual(
            ToolCatalog.plan(tool: "audio_fade", arguments: ["type": .string("out"), "duration": .number(2)], mediaDuration: 6),
            .serverJob(operation: "audio_fade", args: ["type": .string("out"), "duration": .number(2), "start": .number(4)])
        )
        XCTAssertEqual(ToolCatalog.plan(tool: "get_video_dimensions", arguments: [:]), .localQuery(tool: "get_video_dimensions"))
        XCTAssertEqual(ToolCatalog.plan(tool: "not_a_tool", arguments: [:]), .reject(error: "unknown_tool"))
        XCTAssertEqual(
            ToolCatalog.plan(tool: "add_video_transition", arguments: ["transition": .string("fade")]),
            .reject(error: "not_available_on_ios")
        )
        XCTAssertEqual(
            ToolCatalog.plan(tool: "generate_captions", arguments: ["burn_in": .bool(false), "translate_language": .string("es")]),
            .captions(language: "auto", translateLanguage: "es", burnIn: false)
        )
    }

    func testCatalogCoversAllSchemaV1Tools() {
        XCTAssertEqual(ToolCatalog.requiredArgs.count, 46)
        XCTAssertEqual(ToolCatalog.requiredArgs["crop_video"], ["x", "y", "width", "height"])
        XCTAssertEqual(ToolCatalog.requiredArgs["adjust_contrast"], ["contrast"])
    }

    // MARK: - Client-mode contract

    func testDecodesClientModeToolCallsAndFinal() throws {
        let json = """
        {"schemaVersion":"1","status":"tool_calls",
         "toolCalls":[{"id":"call_1","name":"apply_color_filter","arguments":{"filter":"red","intensity":1}},
                      {"id":"call_2","name":"trim_video","arguments":"{\\"start\\":\\"0\\",\\"end\\":\\"5\\"}"}],
         "messages":[{"role":"user","content":"make it red"}],"round":1,"maxRounds":6}
        """
        let response = try JSONDecoder().decode(ClientChatResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.status, "tool_calls")
        XCTAssertEqual(response.toolCalls.count, 2)
        XCTAssertEqual(response.toolCalls[0].arguments["filter"], .string("red"))
        XCTAssertEqual(response.toolCalls[1].arguments["end"], .string("5"))
        XCTAssertEqual(response.maxRounds, 6)

        let final = try JSONDecoder().decode(
            ClientChatResponse.self,
            from: Data(#"{"schemaVersion":"1","status":"final","message":"Applied a red filter."}"#.utf8)
        )
        XCTAssertEqual(final.status, "final")
        XCTAssertEqual(final.finalText, "Applied a red filter.")
        XCTAssertTrue(final.toolCalls.isEmpty)
    }

    func testToolResultMessageShape() {
        let ok = ClientToolResult.success(on: .server).toolMessage(callId: "call_1")
        XCTAssertEqual(ok.jsonString(), #"{"content":{"executedOn":"server","ok":true},"role":"tool","tool_call_id":"call_1"}"#)
        let skipped = ClientToolResult.failure("skipped_by_user", on: .device).toolMessage(callId: "call_2")
        XCTAssertEqual(skipped["content"]?["error"], .string("skipped_by_user"))
        XCTAssertEqual(skipped["content"]?["ok"], .bool(false))
    }

    func testRequestEncodesExecutionClientAndMedia() throws {
        let request = ClientChatRequest(
            messages: [ClientChat.userMessage("make it red")],
            media: ClientMedia(type: "video", duration: 6, width: 1280, height: 720, fps: 30, hasAudio: true)
        )
        let data = try JSONEncoder().encode(request)
        let decoded = try JSONDecoder().decode(JSONValue.self, from: data)
        XCTAssertEqual(decoded["execution"], .string("client"))
        XCTAssertEqual(decoded["media"]?["type"], .string("video"))
        XCTAssertEqual(decoded["media"]?["width"], .number(1280))
        XCTAssertEqual(decoded["messages"]?.arrayValue?.first?["content"], .string("make it red"))
    }

    // MARK: - MIME types

    func testMimeTypeFromExtension() {
        XCTAssertEqual(MediaMIME.mimeType(forExtension: "jpg"), "image/jpeg")
        XCTAssertEqual(MediaMIME.mimeType(forExtension: "JPEG"), "image/jpeg")
        XCTAssertEqual(MediaMIME.mimeType(forExtension: "heic"), "image/heic")
        XCTAssertEqual(MediaMIME.mimeType(forExtension: "png"), "image/png")
        XCTAssertEqual(MediaMIME.mimeType(forExtension: "MOV"), "video/quicktime")
        XCTAssertEqual(MediaMIME.mimeType(forExtension: "mp4"), "video/mp4")
        XCTAssertEqual(MediaMIME.mimeType(forExtension: "m4v"), "video/x-m4v")
        XCTAssertEqual(MediaMIME.mimeType(for: URL(fileURLWithPath: "/tmp/IMG_0001.MOV")), "video/quicktime")
        XCTAssertEqual(EditorViewModel.mimeType(for: URL(fileURLWithPath: "/tmp/a.mov")), "video/quicktime")
    }

    func testMimeTypeFromUTType() {
        XCTAssertEqual(MediaMIME.mimeType(for: UTType.jpeg), "image/jpeg")
        XCTAssertEqual(MediaMIME.mimeType(for: UTType.heic), "image/heic")
        XCTAssertEqual(MediaMIME.mimeType(for: UTType.png), "image/png")
        XCTAssertEqual(MediaMIME.mimeType(for: UTType.quickTimeMovie), "video/quicktime")
        XCTAssertEqual(MediaMIME.mimeType(for: UTType.mpeg4Movie), "video/mp4")
    }

    func testImportedFilenameMatchesContentType() {
        XCTAssertEqual(MediaMIME.filename(for: URL(fileURLWithPath: "/t/IMG_1.MOV"), contentType: .quickTimeMovie), "IMG_1.MOV")
        XCTAssertEqual(MediaMIME.filename(for: URL(fileURLWithPath: "/t/IMG_1.mp4"), contentType: .movie), "IMG_1.mp4")
        XCTAssertEqual(MediaMIME.filename(for: URL(fileURLWithPath: "/t/IMG_1"), contentType: .quickTimeMovie), "IMG_1.mov")
        XCTAssertEqual(MediaMIME.filename(for: URL(fileURLWithPath: "/t/IMG_1.mov"), contentType: .mpeg4Movie), "IMG_1.mp4")
        XCTAssertEqual(MediaMIME.filename(for: URL(fileURLWithPath: "/t/photo"), contentType: .jpeg), "photo.jpeg")
    }

    func testImportCopyKeepsRealExtensionAndMime() throws {
        let source = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).MOV")
        try Data("mov".utf8).write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }
        let imported = try ImportedVideo.copy(from: source, contentType: .quickTimeMovie)
        defer { try? FileManager.default.removeItem(at: imported.url.deletingLastPathComponent()) }
        XCTAssertEqual(imported.url.pathExtension, "MOV")
        XCTAssertEqual(imported.mimeType, "video/quicktime")
    }

    // MARK: - Result extension from content type

    func testExtensionFromContentType() {
        XCTAssertEqual(MediaMIME.fileExtension(forContentType: "image/jpeg"), "jpg")
        XCTAssertEqual(MediaMIME.fileExtension(forContentType: "image/png"), "png")
        XCTAssertEqual(MediaMIME.fileExtension(forContentType: "video/quicktime"), "mov")
        XCTAssertEqual(MediaMIME.fileExtension(forContentType: "video/mp4"), "mp4")
        XCTAssertEqual(MediaMIME.fileExtension(forContentType: "video/mp4; charset=binary"), "mp4")
        XCTAssertEqual(MediaMIME.fileExtension(forContentType: "IMAGE/JPEG"), "jpg")
        XCTAssertEqual(MediaMIME.fileExtension(forContentType: "audio/mpeg"), "mp3")
        XCTAssertEqual(MediaMIME.fileExtension(forContentType: "image/webp"), "webp")
    }

    func testExtensionFallsBackToMediaType() {
        XCTAssertEqual(MediaMIME.fileExtension(forContentType: nil, mediaType: "image"), "jpg")
        XCTAssertEqual(MediaMIME.fileExtension(forContentType: "application/octet-stream", mediaType: "image"), "jpg")
        XCTAssertEqual(MediaMIME.fileExtension(forContentType: nil, mediaType: "video"), "mp4")
        XCTAssertEqual(MediaMIME.fileExtension(forContentType: nil), "mp4")
        XCTAssertEqual(MediaMIME.fileExtension(forContentType: "image/png", mediaType: "video"), "png")
    }

    func testJobPollDecodesMediaTypeAndContentType() throws {
        let json = #"{"jobId":"j1","status":"succeeded","mediaType":"image","contentType":"image/png","resultUrl":"https://grepawk.com/api/jobs/j1/result"}"#
        let poll = try JSONDecoder().decode(JobPollResponse.self, from: Data(json.utf8))
        XCTAssertEqual(poll.mediaType, "image")
        XCTAssertEqual(MediaMIME.fileExtension(forContentType: poll.contentType, mediaType: poll.mediaType), "png")
        XCTAssertTrue(MediaMIME.isImage(extension: "png"))
        XCTAssertFalse(MediaMIME.isImage(extension: "mov"))
    }

    // MARK: - Execution never hits the network for invalid calls

    @MainActor
    func testExecuteToolCallRejectsMissingArgsWithoutNetwork() async {
        let model = EditorViewModel()
        model.localVideoURL = Bundle.main.url(forResource: "finalcap-test-video", withExtension: "mp4")
        // No apiClient: a server job would fail with "no_media"; a rejected call never gets that far.
        let result = await model.executeToolCall(ClientToolCall(id: "c1", name: "trim_video", arguments: [:]))
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.error, "invalid_arguments")
        XCTAssertEqual(result.executedOn, .device)
    }

    @MainActor
    func testGetVideoDimensionsAnsweredLocally() async throws {
        let model = EditorViewModel()
        model.localVideoURL = try XCTUnwrap(Bundle.main.url(forResource: "finalcap-test-video", withExtension: "mp4"))
        let result = await model.executeToolCall(ClientToolCall(id: "c2", name: "get_video_dimensions", arguments: [:]))
        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.executedOn, .device)
        XCTAssertEqual(result.output?["width"], .number(1280))
        XCTAssertEqual(result.output?["height"], .number(720))
    }
}
