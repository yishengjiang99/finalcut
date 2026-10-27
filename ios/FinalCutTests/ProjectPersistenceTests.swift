import AVFoundation
import XCTest
@testable import FinalCut

/// Phase A/F persistence + legacy-adapter tests: durable layout on disk, relaunch
/// recovery data, missing-asset reporting, and the single-clip → project migration
/// (including the soundtrack op becoming a normal music-track clip).
final class ProjectPersistenceTests: XCTestCase {
    private var base: URL!

    override func setUpWithError() throws {
        base = FileManager.default.temporaryDirectory.appendingPathComponent("fc-project-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        ProjectStore.baseDirectoryOverride = base
    }

    override func tearDownWithError() throws {
        ProjectStore.baseDirectoryOverride = nil
        try? FileManager.default.removeItem(at: base)
    }

    private func makeProject() -> EditorProject {
        var project = EditorProject(name: "Persisted", canvas: ProjectCanvas(width: 1280, height: 720))
        let asset = MediaAsset(id: UUID(), relativePath: "placeholder", name: "clip.mov", mediaType: .video,
                               duration: .seconds(6), naturalSize: CodableSize(width: 1280, height: 720),
                               preferredTransform: .identity, nominalFrameRate: 30, hasAudio: true)
        project.assets = [asset]
        project.videoClips = [VideoClip(id: UUID(), assetID: asset.id, sourceStart: .zero, sourceEnd: .seconds(6))]
        return project
    }

    func testSaveLoadRoundTripAndMediaAdoption() throws {
        var project = makeProject()
        // A media file outside the project (as the legacy importer would produce).
        let outside = base.appendingPathComponent("outside.mov")
        try Data("video-bytes".utf8).write(to: outside)
        project.assets[0].relativePath = outside.path

        try ProjectStore.adoptExternalAssets(&project)
        XCTAssertTrue(project.assets[0].relativePath.hasPrefix("Media/"))
        let stored = ProjectStore.resolve(project.assets[0], in: project)
        XCTAssertEqual(try Data(contentsOf: stored), Data("video-bytes".utf8))

        try ProjectStore.save(project)
        let loaded = try ProjectStore.load(project.id)
        XCTAssertEqual(loaded, project)
        XCTAssertEqual(ProjectStore.loadAll().map(\.id), [project.id])
        XCTAssertTrue(ProjectStore.missingAssets(loaded).isEmpty)

        // Delete the media: the project still loads, the asset is reported missing.
        try FileManager.default.removeItem(at: stored)
        XCTAssertEqual(ProjectStore.missingAssets(loaded).map(\.name), ["clip.mov"])
        XCTAssertNoThrow(try ProjectStore.load(project.id))
    }

    func testCopyIntoProjectIsStableAndDedupesAsset() throws {
        let project = makeProject()
        let source = base.appendingPathComponent("song.m4a")
        try Data(repeating: 7, count: 4096).write(to: source)
        let assetID = UUID()
        let rel1 = try ProjectStore.copyIntoProject(source: source, projectID: project.id, assetID: assetID)
        let rel2 = try ProjectStore.copyIntoProject(source: source, projectID: project.id, assetID: assetID)
        XCTAssertEqual(rel1, rel2)
        XCTAssertTrue(rel1.hasSuffix(".m4a"))
    }

    func testLegacyStackAdaptsToOneClipProject() {
        let url = URL(fileURLWithPath: "/tmp/base.mov")
        var stack = EditStack(base: url, baseCanvas: NativeCanvas(width: 1920, height: 1080, duration: 20, isPhoto: false, hasAudio: true))
        stack.push(EditEntry(tool: "trim_video", op: .trim(start: 2, end: 12)))
        stack.push(EditEntry(tool: "adjust_speed", op: .speed(2)))
        stack.push(EditEntry(tool: "adjust_brightness", op: .colorControls(brightness: 0.2, contrast: 1, saturation: 1)))
        let project = stack.makeProject()
        XCTAssertEqual(project.videoClips.count, 1)
        XCTAssertEqual(project.videoClips[0].sourceStart.seconds, 2, accuracy: 0.001)
        XCTAssertEqual(project.videoClips[0].sourceEnd.seconds, 12, accuracy: 0.001)
        XCTAssertEqual(project.videoClips[0].speed, 2, accuracy: 0.001)
        XCTAssertEqual(project.durationSeconds, 5, accuracy: 0.001)
        XCTAssertEqual(project.videoClips[0].effects.count, 1)
        XCTAssertFalse(stack.isTimelineProject) // still the legacy session shape
    }

    func testSoundtrackOpBecomesMusicTrackClip() {
        let url = URL(fileURLWithPath: "/tmp/base.mov")
        let song = URL(fileURLWithPath: "/tmp/song.m4a")
        var stack = EditStack(base: url, baseCanvas: NativeCanvas(width: 1920, height: 1080, duration: 20, isPhoto: false, hasAudio: true))
        stack.push(EditEntry(tool: "youtube_soundtrack", op: .soundtrack(file: song, startOffset: 5, originalVolume: 0)))
        let project = stack.makeProject()
        XCTAssertEqual(project.audioTracks.count, 1)
        XCTAssertEqual(project.audioTracks[0].name, "Soundtrack")
        XCTAssertEqual(project.audioTracks[0].clips.first?.sourceStart.seconds ?? -1, 5, accuracy: 0.001)
        // originalVolume 0 = original audio replaced.
        XCTAssertEqual(project.videoClips[0].originalAudioEnabled, false)
        var adapted = stack
        adapted.project = project
        XCTAssertTrue(adapted.isTimelineProject)
    }
}
