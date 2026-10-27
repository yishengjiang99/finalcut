import CoreMedia
import XCTest
@testable import FinalCut

/// Phase A model tests: exact CMTime storage, derived layout/duration, validation,
/// and the source ↔ clip ↔ project caption mapping.
final class ProjectModelTests: XCTestCase {
    private func asset(_ name: String, seconds: Double, width: Double = 1920, height: Double = 1080, audio: Bool = true) -> MediaAsset {
        MediaAsset(id: UUID(), relativePath: "Media/\(name)", name: name, mediaType: .video,
                   duration: .seconds(seconds), naturalSize: CodableSize(width: width, height: height),
                   preferredTransform: .identity, nominalFrameRate: 30, hasAudio: audio)
    }

    private func projectWithClips(_ specs: [(asset: MediaAsset, start: Double, end: Double, speed: Double)]) -> EditorProject {
        var project = EditorProject(name: "T", canvas: ProjectCanvas(width: 1920, height: 1080))
        project.assets = specs.map(\.asset)
        project.videoClips = specs.map {
            VideoClip(id: UUID(), assetID: $0.asset.id, sourceStart: .seconds($0.start), sourceEnd: .seconds($0.end), speed: $0.speed)
        }
        return project
    }

    func testCodableTimeIsExactAndRoundTrips() throws {
        let time = CodableTime(CMTime(value: 123_457, timescale: 600))
        let data = try JSONEncoder().encode(time)
        let decoded = try JSONDecoder().decode(CodableTime.self, from: data)
        XCTAssertEqual(decoded, time)
        XCTAssertEqual(decoded.cmTime.value, 123_457)
        XCTAssertEqual(decoded.cmTime.timescale, 600)
    }

    func testProjectJSONRoundTripPreservesTimeline() throws {
        var project = projectWithClips([(asset("a.mov", seconds: 10), 1, 9, 2), (asset("b.mov", seconds: 8), 0, 8, 1)])
        project.audioTracks = [AudioTrack(id: UUID(), name: "Music", kind: .music, clips: [
            AudioClip(id: UUID(), assetID: project.assets[0].id, sourceStart: .zero, sourceDuration: .seconds(30),
                      timelineStart: .seconds(2), gain: 0.2, loop: true, repeatUntil: .seconds(20)),
        ])]
        let data = try JSONEncoder().encode(project)
        let decoded = try JSONDecoder().decode(EditorProject.self, from: data)
        XCTAssertEqual(decoded, project)
        XCTAssertEqual(decoded.durationSeconds, project.durationSeconds, accuracy: 0.001)
    }

    func testDurationIsDerivedFromArrangement() {
        // 8s at 2x (=4s) + 8s at 1x = 12s.
        let project = projectWithClips([(asset("a.mov", seconds: 10), 1, 9, 2), (asset("b.mov", seconds: 8), 0, 8, 1)])
        XCTAssertEqual(project.durationSeconds, 12, accuracy: 0.001)
        XCTAssertEqual(project.layout.map { $0.start.seconds }, [0, 4])
    }

    func testTransitionOverlapShortensDuration() {
        var project = projectWithClips([(asset("a.mov", seconds: 10), 0, 10, 1), (asset("b.mov", seconds: 10), 0, 10, 1)])
        project.videoClips[0].transitionOut = TransitionSpec(kind: .crossDissolve, duration: .seconds(1))
        XCTAssertEqual(project.durationSeconds, 19, accuracy: 0.001)
        XCTAssertEqual(project.layout[1].start.seconds, 9, accuracy: 0.001)
        // Overlap clamps to half the shorter neighbour.
        project.videoClips[0].transitionOut = TransitionSpec(kind: .crossDissolve, duration: .seconds(30))
        XCTAssertEqual(project.transitionOverlap(after: 0).seconds, 5, accuracy: 0.001)
    }

    func testValidationCatchesBadRangesAndMissingAssets() {
        var project = projectWithClips([(asset("a.mov", seconds: 10), 0, 12, 1)])
        XCTAssertTrue(project.validationIssues().contains("clip_range_exceeds_asset"))
        project.videoClips[0].sourceEnd = .seconds(9)
        project.videoClips[0].assetID = UUID()
        XCTAssertTrue(project.validationIssues().contains("clip_missing_asset"))
        project.videoClips[0].speed = 9
        XCTAssertTrue(project.validationIssues().contains("clip_speed_out_of_range"))
    }

    func testSourceTimeMappingThroughTrimAndSpeed() {
        let project = projectWithClips([(asset("a.mov", seconds: 20), 5, 15, 2)])
        // Project 2.5s in = local 2.5 * speed 2 = source 5 + 5 = 10s.
        let mapped = project.sourceTime(atProjectTime: CMTime(seconds: 2.5, preferredTimescale: 600))
        XCTAssertEqual(mapped?.sourceTime.seconds ?? -1, 10, accuracy: 0.001)
        XCTAssertNil(project.sourceTime(atProjectTime: CMTime(seconds: 99, preferredTimescale: 600)))
    }

    func testPerClipCaptionsMapToProjectTimeAndFollowReorder() throws {
        var beach = asset("beach.mov", seconds: 10)
        beach.id = UUID()
        var dinner = asset("dinner.mov", seconds: 12)
        dinner.id = UUID()
        var project = EditorProject(name: "T", canvas: .hd1080Landscape)
        project.assets = [beach, dinner]
        var dinnerClip = VideoClip(id: UUID(), assetID: dinner.id, sourceStart: .seconds(2), sourceEnd: .seconds(12), speed: 2)
        dinnerClip.captions = [CaptionCue(start: 4, end: 6, text: "cheers")]
        project.videoClips = [
            VideoClip(id: UUID(), assetID: beach.id, sourceStart: .zero, sourceEnd: .seconds(10)),
            dinnerClip,
        ]
        // Dinner starts at project 10; cue source 4-6 -> local (4-2)/2=1 to (6-2)/2=2 -> project 11-12.
        var cues = project.projectCaptions()
        XCTAssertEqual(cues.count, 1)
        XCTAssertEqual(cues[0].start, 11, accuracy: 0.001)
        XCTAssertEqual(cues[0].end, 12, accuracy: 0.001)
        // Reorder: dinner first -> cue moves to 1-2s. No duplication, no loss.
        try ProjectCommandExecutor.apply(.reorderVideoClips(orderedIDs: [dinnerClip.id, project.videoClips[0].id]), to: &project)
        cues = project.projectCaptions()
        XCTAssertEqual(cues.count, 1)
        XCTAssertEqual(cues[0].start, 1, accuracy: 0.001)
    }
}
