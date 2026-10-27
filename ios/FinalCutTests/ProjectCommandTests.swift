import XCTest
@testable import FinalCut

/// Phase A–E command-layer tests, including the spec's acceptance scenario executed
/// entirely through `ProjectCommandExecutor` + `ProjectSession` (the same path the UI
/// buttons and the AI tools take).
final class ProjectCommandTests: XCTestCase {
    private struct Fixture {
        var session: ProjectSession
        let beach, hotel, dinner, music, narration: MediaAsset
        var project: EditorProject { session.project }
    }

    private func makeFixture() -> Fixture {
        func asset(_ name: String, _ type: ProjectMediaType, _ seconds: Double, _ w: Double = 0, _ h: Double = 0, audio: Bool = true) -> MediaAsset {
            MediaAsset(id: UUID(), relativePath: "Media/\(name)", name: name, mediaType: type,
                       duration: .seconds(seconds), naturalSize: CodableSize(width: w, height: h),
                       preferredTransform: .identity, nominalFrameRate: 30, hasAudio: audio)
        }
        let beach = asset("beach.mp4", .video, 10, 1080, 1920)
        let hotel = asset("hotel.mp4", .video, 8, 1920, 1080)
        let dinner = asset("dinner.mp4", .video, 12, 1080, 1920)
        let music = asset("music.m4a", .audio, 60, audio: true)
        let narration = asset("narration.m4a", .audio, 8, audio: true)
        var project = EditorProject(name: "Acceptance", canvas: MediaProbe.defaultCanvas(for: [beach]))
        project.assets = [beach, hotel, dinner, music, narration]
        return Fixture(session: ProjectSession(project: project),
                       beach: beach, hotel: hotel, dinner: dinner, music: music, narration: narration)
    }

    /// Acceptance: beach 10s + hotel 8s + dinner 12s, reordered beach/dinner/hotel,
    /// dinner trimmed to 5s → 23s; music 60s at 20% over the whole timeline,
    /// narration 8s at 12s, music fades out over the last 2s; undo restores each step.
    func testAcceptanceScenario() throws {
        var f = makeFixture()
        XCTAssertEqual(f.project.canvas.width, 1080) // first clip is portrait
        XCTAssertEqual(f.project.canvas.height, 1920)

        for asset in [f.beach, f.hotel, f.dinner] {
            _ = try f.session.perform(.appendVideoClip(assetID: asset.id, sourceStart: nil, sourceEnd: nil))
        }
        XCTAssertEqual(f.project.durationSeconds, 30, accuracy: 0.001)

        let ids = f.project.videoClips.map(\.id)
        _ = try f.session.perform(.reorderVideoClips(orderedIDs: [ids[0], ids[2], ids[1]]))
        XCTAssertEqual(f.project.videoClips.map(\.assetID), [f.beach.id, f.dinner.id, f.hotel.id])

        let dinnerClip = f.project.videoClips[1]
        _ = try f.session.perform(.trimVideoClip(clipID: dinnerClip.id, sourceStart: 0, sourceEnd: 5))
        XCTAssertEqual(f.project.durationSeconds, 23, accuracy: 0.001)

        let musicTrack = try f.session.perform(.createAudioTrack(name: "Music", kind: .music)).createdID
        let musicClip = try f.session.perform(.insertAudioClip(
            trackID: musicTrack!, assetID: f.music.id, timelineStart: 0,
            sourceStart: nil, sourceDuration: nil, gain: 0.2, loop: false, repeatUntil: nil)).createdID
        let voiceTrack = try f.session.perform(.createAudioTrack(name: "Narration", kind: .voiceover)).createdID
        _ = try f.session.perform(.insertAudioClip(
            trackID: voiceTrack!, assetID: f.narration.id, timelineStart: 12,
            sourceStart: nil, sourceDuration: nil, gain: nil, loop: false, repeatUntil: nil))
        _ = try f.session.perform(.setAudioFade(clipID: musicClip!, isIn: false, duration: 2))

        let summary = f.project.summary()
        XCTAssertEqual(summary.durationSeconds, 23, accuracy: 0.001)
        XCTAssertEqual(summary.videoClips.map(\.assetID), [f.beach.id, f.dinner.id, f.hotel.id].map(\.uuidString))
        let musicSummary = summary.audioTracks.first { $0.name == "Music" }?.clips.first
        XCTAssertEqual(musicSummary?.gain ?? -1, 0.2, accuracy: 0.001)
        XCTAssertEqual(musicSummary?.fadeOut ?? -1, 2, accuracy: 0.001)
        let narrationSummary = summary.audioTracks.first { $0.name == "Narration" }?.clips.first
        XCTAssertEqual(narrationSummary?.timelineStartSeconds ?? -1, 12, accuracy: 0.001)
        XCTAssertTrue(f.project.isValid)

        // Undo walks every step back to the empty project; redo replays to 23s.
        var steps = 0
        while f.session.undo() { steps += 1 }
        XCTAssertGreaterThan(steps, 5)
        XCTAssertEqual(f.project.videoClips.count, 0)
        XCTAssertEqual(f.project.durationSeconds, 0, accuracy: 0.001)
        while f.session.redo() {}
        XCTAssertEqual(f.project.durationSeconds, 23, accuracy: 0.001)
        XCTAssertEqual(f.project.videoClips.count, 3)
    }

    func testSplitPreservesTotalDurationAndCaptions() throws {
        var f = makeFixture()
        _ = try f.session.perform(.appendVideoClip(assetID: f.beach.id, sourceStart: nil, sourceEnd: nil))
        let clipID = f.project.videoClips[0].id
        let result = try f.session.perform(.splitVideoClip(clipID: clipID, atProjectTime: 4))
        XCTAssertEqual(f.project.videoClips.count, 2)
        XCTAssertEqual(f.project.durationSeconds, 10, accuracy: 0.001)
        XCTAssertEqual(f.project.videoClips[0].sourceEnd.seconds, 4, accuracy: 0.001)
        XCTAssertEqual(f.project.videoClips[1].sourceStart.seconds, 4, accuracy: 0.001)
        XCTAssertNotNil(result.createdID)
        // Split outside the clip is rejected and changes nothing.
        XCTAssertThrowsError(try f.session.perform(.splitVideoClip(clipID: clipID, atProjectTime: 400)))
        XCTAssertEqual(f.project.videoClips.count, 2)
    }

    func testInvalidCommandsAreAtomic() throws {
        var f = makeFixture()
        _ = try f.session.perform(.appendVideoClip(assetID: f.beach.id, sourceStart: nil, sourceEnd: nil))
        let before = f.project
        XCTAssertThrowsError(try f.session.perform(.trimVideoClip(clipID: UUID(), sourceStart: 0, sourceEnd: 1)))
        XCTAssertThrowsError(try f.session.perform(.reorderVideoClips(orderedIDs: [UUID()])))
        XCTAssertThrowsError(try f.session.perform(.setVideoClipSpeed(clipID: before.videoClips[0].id, speed: 99)))
        XCTAssertEqual(f.project, before)
    }

    func testAudioOverlapAndLoopCommands() throws {
        var f = makeFixture()
        _ = try f.session.perform(.appendVideoClip(assetID: f.beach.id, sourceStart: nil, sourceEnd: nil))
        let track = try f.session.perform(.createAudioTrack(name: "Music", kind: .music)).createdID!
        let a = try f.session.perform(.insertAudioClip(trackID: track, assetID: f.music.id, timelineStart: 0,
                                                       sourceStart: 0, sourceDuration: 10, gain: nil, loop: false, repeatUntil: nil)).createdID!
        // Overlapping insert on the same track is legal (mixed by the composer).
        _ = try f.session.perform(.insertAudioClip(trackID: track, assetID: f.narration.id, timelineStart: 5,
                                                    sourceStart: nil, sourceDuration: nil, gain: nil, loop: false, repeatUntil: nil))
        _ = try f.session.perform(.loopAudioClip(clipID: a, repeatUntil: 23))
        let clip = f.project.audioClip(a)?.clip
        XCTAssertEqual(clip?.loop, true)
        XCTAssertEqual(clip?.repeatUntil?.seconds ?? -1, 23, accuracy: 0.001)
        _ = try f.session.perform(.moveAudioClip(clipID: a, toTrackID: nil, timelineStart: 3))
        XCTAssertEqual(f.project.audioClip(a)?.clip.timelineStart.seconds ?? -1, 3, accuracy: 0.001)
        XCTAssertTrue(f.project.isValid)
    }
}
