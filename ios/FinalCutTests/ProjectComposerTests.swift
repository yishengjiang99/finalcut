import AVFoundation
import CoreImage
import CoreMedia
import XCTest
@testable import FinalCut

/// Phase B/C composer tests against REAL generated media: sequential multi-clip
/// composition, per-clip ranges/speed, overlapping audio lanes, orientation metadata,
/// and preview/export parity (the export of a composed project matches its duration
/// and canvas).
final class ProjectComposerTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("fc-composer-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    // MARK: Media generation (AVAssetWriter; no bundled fixtures needed)

    private func makeVideo(name: String, seconds: Double = 3, rotate: Bool = false, gray: UInt8 = 0) async throws -> URL {
        let url = dir.appendingPathComponent(name)
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 64, AVVideoHeightKey: 48,
        ])
        if rotate { input.transform = CGAffineTransform(rotationAngle: .pi / 2) }
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input)
        // Silent AAC track so the asset "has audio" like a camera clip.
        let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44_100, AVNumberOfChannelsKey: 1,
        ])
        writer.add(input)
        writer.add(audioInput)
        guard writer.startWriting() else { throw try XCTUnwrap(writer.error) }
        writer.startSession(atSourceTime: .zero)
        var buffer: CVPixelBuffer?
        CVPixelBufferCreate(kCFAllocatorDefault, 64, 48, kCVPixelFormatType_32ARGB, nil, &buffer)
        let frame = try XCTUnwrap(buffer)
        CVPixelBufferLockBaseAddress(frame, [])
        memset(CVPixelBufferGetBaseAddress(frame), Int32(gray), CVPixelBufferGetDataSize(frame))
        CVPixelBufferUnlockBaseAddress(frame, [])
        // Video frames and silence buffers covering the same span, interleaved: the writer
        // stops accepting one track until the other catches up, so writing all video first
        // waits forever for `isReadyForMoreMediaData`.
        for index in 0..<Int(seconds * 10) {
            while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(5)) }
            XCTAssertTrue(adaptor.append(frame, withPresentationTime: CMTime(value: Int64(index), timescale: 10)))
            while !audioInput.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(5)) }
            let sample = try Self.silentSampleBuffer(start: CMTime(value: Int64(index * 4410), timescale: 44_100), frames: 4410)
            XCTAssertTrue(audioInput.append(sample))
        }
        input.markAsFinished()
        audioInput.markAsFinished()
        await writer.finishWriting()
        XCTAssertEqual(writer.status, .completed, writer.error?.localizedDescription ?? "")
        return url
    }

    private func makeAudio(name: String, seconds: Double = 5) async throws -> URL {
        let url = dir.appendingPathComponent(name)
        let writer = try AVAssetWriter(outputURL: url, fileType: .m4a)
        let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44_100, AVNumberOfChannelsKey: 1,
        ])
        writer.add(input)
        guard writer.startWriting() else { throw try XCTUnwrap(writer.error) }
        writer.startSession(atSourceTime: .zero)
        for chunk in 0..<Int(seconds * 10) {
            while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(5)) }
            let sample = try Self.silentSampleBuffer(start: CMTime(value: Int64(chunk * 4410), timescale: 44_100), frames: 4410)
            XCTAssertTrue(input.append(sample))
        }
        input.markAsFinished()
        await writer.finishWriting()
        XCTAssertEqual(writer.status, .completed, writer.error?.localizedDescription ?? "")
        return url
    }

    private static func silentSampleBuffer(start: CMTime, frames: Int) throws -> CMSampleBuffer {
        let bytes = frames * MemoryLayout<Int16>.size
        let block = try CMBlockBuffer(length: bytes, flags: [])
        var asbd = AudioStreamBasicDescription(
            mSampleRate: 44_100, mFormatID: kAudioFormatLinearPCM, mFormatFlags: kAudioFormatFlagIsSignedInteger,
            mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2, mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)
        var formatDescription: CMAudioFormatDescription?
        guard CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &asbd, layoutSize: 0, layout: nil,
                                             magicCookieSize: 0, magicCookie: nil, extensions: nil,
                                             formatDescriptionOut: &formatDescription) == noErr,
              let formatDescription else { throw NSError(domain: "test", code: -1) }
        var sampleBuffer: CMSampleBuffer?
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 44_100), presentationTimeStamp: start, decodeTimeStamp: .invalid)
        let status = CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: block, dataReady: true,
                                          makeDataReadyCallback: nil, refcon: nil, formatDescription: formatDescription,
                                          sampleCount: frames, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
                                          sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &sampleBuffer)
        guard status == noErr, let sampleBuffer else { throw NSError(domain: "test", code: Int(status)) }
        return sampleBuffer
    }

    private func probeAsset(_ url: URL, type: ProjectMediaType) async throws -> MediaAsset {
        try await MediaProbe.probe(url: url, relativePath: url.path, name: url.lastPathComponent)
    }

    // MARK: Tests

    func testTwoClipsComposeSequentiallyWithRangesAndSpeed() async throws {
        let videoURL = try await makeVideo(name: "a.mp4")
        let video = try await probeAsset(videoURL, type: .video)
        var project = EditorProject(name: "T", canvas: ProjectCanvas(width: 128, height: 96))
        project.assets = [video]
        project.videoClips = [
            VideoClip(id: UUID(), assetID: video.id, sourceStart: .zero, sourceEnd: .seconds(2)),
            VideoClip(id: UUID(), assetID: video.id, sourceStart: .seconds(1), sourceEnd: .seconds(2.5), speed: 2),
        ]
        let composed = try await NativeComposer.compose(project: project) { _ in videoURL }
        // 2s + 1.5s/2 = 2.75s.
        XCTAssertEqual(composed.duration, 2.75, accuracy: 0.15)
        XCTAssertEqual(composed.renderSize, CGSize(width: 128, height: 96))
        let videoTracks = try await composed.asset.loadTracks(withMediaType: .video)
        XCTAssertEqual(videoTracks.count, 1)
        let item = composed.makePlayerItem()
        XCTAssertNotNil(item.videoComposition)
        XCTAssertNotNil(item.audioMix)
    }

    func testOverlappingAudioClipsGetSeparateLanesAndClampToProjectEnd() async throws {
        let videoURL = try await makeVideo(name: "a.mp4")
        let audioURL = try await makeAudio(name: "music.m4a", seconds: 30)
        let video = try await probeAsset(videoURL, type: .video)
        let music = try await probeAsset(audioURL, type: .audio)
        var project = EditorProject(name: "T", canvas: ProjectCanvas(width: 128, height: 96))
        project.assets = [video, music]
        project.videoClips = [VideoClip(id: UUID(), assetID: video.id, sourceStart: .zero, sourceEnd: .seconds(3))]
        var track = AudioTrack(id: UUID(), name: "Music", kind: .music)
        track.clips = [
            AudioClip(id: UUID(), assetID: music.id, sourceStart: .zero, sourceDuration: .seconds(30), timelineStart: .zero, gain: 0.2),
            AudioClip(id: UUID(), assetID: music.id, sourceStart: .zero, sourceDuration: .seconds(30), timelineStart: .seconds(1), gain: 0.5),
        ]
        project.audioTracks = [track]
        let composed = try await NativeComposer.compose(project: project) { $0.id == music.id ? audioURL : videoURL }
        // The 30s song does NOT stretch the 3s project.
        XCTAssertEqual(composed.duration, 3, accuracy: 0.15)
        // Original audio lane + two overlapping music lanes.
        let audioTracks = try await composed.asset.loadTracks(withMediaType: .audio)
        XCTAssertGreaterThanOrEqual(audioTracks.count, 3)
        XCTAssertEqual(composed.audioMix?.inputParameters.count, audioTracks.count)
    }

    func testRotatedClipComposesIntoCanvas() async throws {
        let videoURL = try await makeVideo(name: "rot.mp4", rotate: true)
        let video = try await probeAsset(videoURL, type: .video)
        XCTAssertEqual(video.preferredTransform.cgTransform.b, 1, accuracy: 0.001) // 90° rotation stored
        var project = EditorProject(name: "T", canvas: ProjectCanvas(width: 96, height: 128))
        project.assets = [video]
        project.videoClips = [VideoClip(id: UUID(), assetID: video.id, sourceStart: .zero, sourceEnd: .seconds(1))]
        let composed = try await NativeComposer.compose(project: project) { _ in videoURL }
        XCTAssertEqual(composed.renderSize, CGSize(width: 96, height: 128))
        XCTAssertEqual(composed.duration, 1, accuracy: 0.15)
    }

    func testExportMatchesComposedDurationAndCanvas() async throws {
        let videoURL = try await makeVideo(name: "a.mp4")
        let video = try await probeAsset(videoURL, type: .video)
        var project = EditorProject(name: "T", canvas: ProjectCanvas(width: 128, height: 96))
        project.assets = [video]
        project.videoClips = [
            VideoClip(id: UUID(), assetID: video.id, sourceStart: .zero, sourceEnd: .seconds(2)),
            VideoClip(id: UUID(), assetID: video.id, sourceStart: .zero, sourceEnd: .seconds(1)),
        ]
        let composed = try await NativeComposer.compose(project: project) { _ in videoURL }
        let out = try await NativeExporter().export(composed, format: "mp4") { _ in }
        defer { try? FileManager.default.removeItem(at: out) }
        let exported = AVURLAsset(url: out)
        let duration = try await exported.load(.duration).seconds
        XCTAssertEqual(duration, composed.duration, accuracy: 0.2)
        let track = try await exported.loadTracks(withMediaType: .video).first
        let size = try await track?.load(.naturalSize)
        XCTAssertEqual(size?.width ?? 0, 128, accuracy: 1)
        XCTAssertEqual(size?.height ?? 0, 96, accuracy: 1)
    }

    // MARK: Regression: a timeline edit must not turn the preview / export black

    private func meanLuma(_ cgImage: CGImage) -> Double {
        let image = CIImage(cgImage: cgImage)
        let average = image.applyingFilter("CIAreaAverage", parameters: [kCIInputExtentKey: CIVector(cgRect: image.extent)])
        var pixel = [UInt8](repeating: 0, count: 4)
        CIContext().render(average, toBitmap: &pixel, rowBytes: 4, bounds: CGRect(x: 0, y: 0, width: 1, height: 1),
                           format: .RGBA8, colorSpace: nil)
        return (Double(pixel[0]) + Double(pixel[1]) + Double(pixel[2])) / 3
    }

    func testSplitProjectPreviewAndExportFramesAreNotBlack() async throws {
        let videoURL = try await makeVideo(name: "gray.mp4", seconds: 4, gray: 0x90)
        var stack = EditStack(base: videoURL, baseCanvas: NativeCanvas(width: 64, height: 48, duration: 4, isPhoto: false, hasAudio: true))
        stack.project = stack.makeProject()
        let clipID = try XCTUnwrap(stack.project?.videoClips.first?.id)
        try stack.performProjectCommand(.splitVideoClip(clipID: clipID, atProjectTime: 2))
        XCTAssertTrue(stack.isTimelineProject)
        let project = try XCTUnwrap(stack.project)
        XCTAssertEqual(project.videoClips.count, 2)

        let composed = try await NativeComposer.compose(project: project) { _ in videoURL }
        let generator = composed.makeImageGenerator()
        for t in [0.5, 3.0] { // one frame from each half of the split
            let frame = try await generator.image(at: CMTime(seconds: t, preferredTimescale: 600)).image
            XCTAssertGreaterThan(meanLuma(frame), 60, "preview frame at \(t)s is black")
        }
        let out = try await NativeExporter().export(composed, format: "mp4") { _ in }
        defer { try? FileManager.default.removeItem(at: out) }
        let exported = AVAssetImageGenerator(asset: AVURLAsset(url: out))
        exported.requestedTimeToleranceBefore = .zero
        exported.requestedTimeToleranceAfter = .zero
        let frame = try await exported.image(at: CMTime(seconds: 3, preferredTimescale: 600)).image
        XCTAssertGreaterThan(meanLuma(frame), 60, "exported frame is black")
    }
}
