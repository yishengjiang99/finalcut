import AVFoundation
import CoreImage
import UIKit
import XCTest
@testable import FinalCut

/// Renders real edits of the bundled clip (1280x720 color bars, 6 s, 880 Hz tone).
/// Bars at y=360: red 0-216, green 216-428, yellow 428-640, blue 640-856, magenta 856-1068, cyan 1068-1280.
final class NativeToolTests: XCTestCase {
    private var clip: URL {
        get throws { try XCTUnwrap(Bundle.main.url(forResource: "finalcap-test-video", withExtension: "mp4")) }
    }
    private let canvas = NativeCanvas(width: 1280, height: 720, duration: 6, isPhoto: false, hasAudio: true)

    private func stack(_ ops: [NativeOp]) throws -> EditStack {
        var s = EditStack(base: try clip, baseCanvas: canvas)
        for op in ops { s.push(EditEntry(tool: "test", op: op)) }
        return s
    }

    private func composed(_ ops: [NativeOp]) async throws -> ComposedVideo {
        try await NativeComposer.compose(try stack(ops))
    }

    private func frame(_ ops: [NativeOp], at seconds: Double = 1) async throws -> CGImage {
        let video = try await composed(ops)
        return try await video.makeImageGenerator().image(at: CMTime(seconds: seconds, preferredTimescale: 600)).image
    }

    private func pixel(_ image: CGImage, _ x: Int, _ y: Int) -> (r: Int, g: Int, b: Int) {
        var data = [UInt8](repeating: 0, count: 4)
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let ctx = CGContext(data: &data, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: space,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        // Draw so that pixel (x, y) (top-left origin) lands on the 1x1 context.
        ctx.draw(image, in: CGRect(x: -x, y: -(image.height - 1 - y), width: image.width, height: image.height))
        return (Int(data[0]), Int(data[1]), Int(data[2]))
    }

    // MARK: - Timeline

    func testTrimAndSpeedDurations() async throws {
        let trimmed = try await composed([.trim(start: 1, end: 3)])
        XCTAssertEqual(trimmed.duration, 2, accuracy: 0.05)
        let fast = try await composed([.speed(2)])
        XCTAssertEqual(fast.duration, 3, accuracy: 0.05)
        let both = try await composed([.trim(start: 1, end: 5), .speed(0.5)])
        XCTAssertEqual(both.duration, 8, accuracy: 0.05)
    }

    // MARK: - Geometry

    func testCropRotateResizePadDimensions() async throws {
        let crop = try await frame([.crop(x: 428, y: 0, width: 212, height: 720)])
        XCTAssertEqual([crop.width, crop.height], [212, 720])
        let yellow = pixel(crop, 106, 360)
        XCTAssertGreaterThan(yellow.r, 200); XCTAssertGreaterThan(yellow.g, 200); XCTAssertLessThan(yellow.b, 60)

        let rotated = try await frame([.rotate(degrees: 90)])
        XCTAssertEqual([rotated.width, rotated.height], [720, 1280])
        // Clockwise: the left (red) edge becomes the top.
        let top = pixel(rotated, 360, 100)
        XCTAssertGreaterThan(top.r, 200); XCTAssertLessThan(top.g, 60); XCTAssertLessThan(top.b, 60)

        let resized = try await frame([.resize(width: 640, height: 360)])
        XCTAssertEqual([resized.width, resized.height], [640, 360])

        let padded = try await frame([.pad(width: 1080, height: 1920)])
        XCTAssertEqual([padded.width, padded.height], [1080, 1920])
        let bar = pixel(padded, 540, 100)
        XCTAssertLessThan(bar.r + bar.g + bar.b, 40, "letterbox should be black")
    }

    func testFlipHorizontalSwapsSides() async throws {
        let flipped = try await frame([.flipHorizontal])
        let left = pixel(flipped, 100, 360) // was cyan on the right
        XCTAssertLessThan(left.r, 60); XCTAssertGreaterThan(left.g, 200); XCTAssertGreaterThan(left.b, 200)
        let right = pixel(flipped, 1180, 360) // was red
        XCTAssertGreaterThan(right.r, 200); XCTAssertLessThan(right.g, 60)
    }

    // MARK: - Color

    func testGrayscaleEqualizesChannels() async throws {
        let gray = try await frame([.colorFilter(filter: "grayscale", intensity: 1)])
        for x in [110, 322, 534, 748, 962, 1174] {
            let p = pixel(gray, x, 360)
            XCTAssertLessThanOrEqual(max(p.r, p.g, p.b) - min(p.r, p.g, p.b), 12, "x=\(x) \(p)")
        }
    }

    func testBrightnessRaisesDarkChannels() async throws {
        let bright = try await frame([.colorControls(brightness: 0.3, contrast: 1, saturation: 1)])
        let p = pixel(bright, 110, 360) // red bar: green/blue start near 0
        XCTAssertGreaterThan(p.g, 40)
        XCTAssertGreaterThan(p.b, 40)
    }

    func testInvertFlipsChannels() async throws {
        let inverted = try await frame([.colorFilter(filter: "invert", intensity: 1)])
        let p = pixel(inverted, 534, 360) // yellow → blue-ish
        XCTAssertGreaterThan(p.b, p.r + 50)
        XCTAssertGreaterThan(p.b, p.g + 50)
    }

    func testTextDrawsPixels() async throws {
        let text = try await frame([.text("HELLO", x: 20, y: 20, fontSize: 120, color: .white)])
        var whiteFound = false
        for y in stride(from: 20, to: 200, by: 6) {
            for x in stride(from: 20, to: 420, by: 6) {
                let p = pixel(text, x, y)
                if p.r > 220, p.g > 220, p.b > 220 { whiteFound = true; break }
            }
            if whiteFound { break }
        }
        XCTAssertTrue(whiteFound, "white text over the red bar")
    }

    // MARK: - Audio

    func testVolumeScalesRMS() async throws {
        let base = try await composed([])
        let baseRMS = try await AudioRenderer.rms(asset: base.asset, audioMix: base.audioMix, from: 1, to: 5)
        XCTAssertGreaterThan(baseRMS, 0.03)

        let half = try await composed([.volume(0.5)])
        let halfRMS = try await AudioRenderer.rms(asset: half.asset, audioMix: half.audioMix, from: 1, to: 5)
        XCTAssertEqual(halfRMS / baseRMS, 0.5, accuracy: 0.08)

        let double = try await composed([.volume(2)])
        let doubleRMS = try await AudioRenderer.rms(asset: double.asset, audioMix: double.audioMix, from: 1, to: 5)
        XCTAssertEqual(doubleRMS / baseRMS, 2, accuracy: 0.25)
    }

    func testFadeOutQuietsTheEnd() async throws {
        let base = try await composed([])
        let baseRMS = try await AudioRenderer.rms(asset: base.asset, audioMix: base.audioMix, from: 1, to: 4)
        let faded = try await composed([.fade(isIn: false, duration: 1, start: nil)])
        let head = try await AudioRenderer.rms(asset: faded.asset, audioMix: faded.audioMix, from: 1, to: 4)
        let tail = try await AudioRenderer.rms(asset: faded.asset, audioMix: faded.audioMix, from: 5.6, to: 6)
        XCTAssertEqual(head / baseRMS, 1, accuracy: 0.1)
        XCTAssertLessThan(tail, baseRMS * 0.45)

        let fadeIn = try await composed([.fade(isIn: true, duration: 2, start: nil)])
        let start = try await AudioRenderer.rms(asset: fadeIn.asset, audioMix: fadeIn.audioMix, from: 0, to: 0.4)
        XCTAssertLessThan(start, baseRMS * 0.4)
    }

    // MARK: - Export

    func testExportWritesEditedFile() async throws {
        let video = try await composed([.trim(start: 0, end: 2), .colorFilter(filter: "grayscale", intensity: 1)])
        let url = try await NativeExporter().export(video, format: "mp4", progress: { _ in })
        defer { try? FileManager.default.removeItem(at: url) }
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration).seconds
        XCTAssertEqual(duration, 2, accuracy: 0.15)
        let track = try await XCTUnwrap(asset.loadTracks(withMediaType: .video).first)
        let size = try await track.load(.naturalSize)
        XCTAssertEqual(size, CGSize(width: 1280, height: 720))
        let generator = AVAssetImageGenerator(asset: asset)
        let image = try await generator.image(at: CMTime(seconds: 1, preferredTimescale: 600)).image
        let p = pixel(image, 110, 360)
        XCTAssertLessThanOrEqual(max(p.r, p.g, p.b) - min(p.r, p.g, p.b), 16)
        XCTAssertFalse(try await asset.loadTracks(withMediaType: .audio).isEmpty)
    }

    // MARK: - Photo

    func testPhotoRenderRotateAndFilter() async throws {
        let source = try await frame([])
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let png = dir.appendingPathComponent("bars.png")
        try XCTUnwrap(UIImage(cgImage: source).pngData()).write(to: png)

        var photo = EditStack(base: png, baseCanvas: NativeCanvas(width: 1280, height: 720, duration: 0, isPhoto: true, hasAudio: false))
        photo.push(EditEntry(tool: "rotate_video", op: .rotate(degrees: 90)))
        photo.push(EditEntry(tool: "apply_color_filter", op: .colorFilter(filter: "grayscale", intensity: 1)))
        let rendered = try PhotoRenderer.render(photo)
        XCTAssertEqual(rendered.extent.size, CGSize(width: 720, height: 1280))
        XCTAssertEqual(photo.canvas.width, 720)

        let (data, type) = try PhotoRenderer.exportData(photo)
        XCTAssertEqual(type, .png)
        let decoded = try XCTUnwrap(UIImage(data: data)?.cgImage)
        XCTAssertEqual([decoded.width, decoded.height], [720, 1280])
        let p = pixel(decoded, 360, 600)
        XCTAssertLessThanOrEqual(max(p.r, p.g, p.b) - min(p.r, p.g, p.b), 12)

        photo.push(EditEntry(tool: "convert_image_format", op: .outputFormat("jpg")))
        XCTAssertEqual(PhotoRenderer.outputType(for: photo), .jpeg)
        let file = try PhotoRenderer.exportFile(photo)
        XCTAssertEqual(file.pathExtension, "jpg")
    }
}
