import CoreImage
import UIKit
import XCTest
@testable import FinalCut

final class GroupedToolsTests: XCTestCase {
    let video = NativeCanvas(width: 1280, height: 720, duration: 6, isPhoto: false, hasAudio: true)
    let photo = NativeCanvas(width: 800, height: 600, duration: 0, isPhoto: true, hasAudio: false)
    let context = CIContext(options: [.cacheIntermediates: false])

    private func plan(_ tool: String, _ args: [String: JSONValue], _ canvas: NativeCanvas? = nil) -> Result<NativePlan, NativeToolError> {
        NativeToolParser.plan(tool: tool, arguments: args, canvas: canvas ?? video)
    }

    private func op(_ tool: String, _ args: [String: JSONValue], _ canvas: NativeCanvas? = nil) -> NativeOp? {
        if case .success(.apply(let o)) = plan(tool, args, canvas) { return o }
        return nil
    }

    private func isInvalid(_ r: Result<NativePlan, NativeToolError>) -> Bool {
        if case .failure(.invalidArguments) = r { return true }
        return false
    }

    // MARK: - Catalog / parser contract

    func testGroupedToolsAreSupportedAndInTheCatalog() {
        for name in GroupedToolCatalog.allTools {
            XCTAssertTrue(NativeToolParser.isSupported(name), name)
            XCTAssertTrue(ToolCatalog.isKnown(name), name)
        }
        XCTAssertTrue(NativeToolParser.photoTools.isSuperset(of: GroupedToolCatalog.photoTools))
        XCTAssertFalse(NativeToolParser.photoTools.contains("audio_effect"))
    }

    func testRequiredArgsAndUnknownEnums() {
        XCTAssertTrue(isInvalid(plan("channel_mixer", [:])))
        XCTAssertEqual(plan("channel_mixer", ["preset": .string("not_a_preset")]), .failure(.unsupportedOnDevice))
        XCTAssertTrue(isInvalid(plan("color_adjust", [:])))
        XCTAssertTrue(isInvalid(plan("color_adjust", ["adjust": .array([])])))
        XCTAssertEqual(plan("color_adjust", ["adjust": .array([.string("blur")])]), .failure(.unsupportedOnDevice))
        XCTAssertEqual(plan("apply_filter", ["name": .string("gaussian_blur")]), .failure(.unsupportedOnDevice))
        XCTAssertEqual(plan("stylize", ["preset": .string("noir")]), .failure(.unsupportedOnDevice))
        XCTAssertEqual(plan("lut", ["preset": .string("comic")]), .failure(.unsupportedOnDevice))
        XCTAssertEqual(plan("blur_sharpen", ["mode": .string("vignette")]), .failure(.unsupportedOnDevice))
        XCTAssertEqual(plan("segment", ["action": .string("sharpen")]), .failure(.unsupportedOnDevice))
        XCTAssertEqual(plan("audio_effect", ["effect": .string("chorus")]), .failure(.unsupportedOnDevice))
    }

    func testDefaultsAndClamping() {
        guard case .channelMixer(let m) = op("channel_mixer", ["preset": .string("remove_red")]) else {
            return XCTFail("channel_mixer")
        }
        XCTAssertEqual(m.intensity, 0.5)
        guard case .channelMixer(let clamped) = op("channel_mixer", ["preset": .string("remove_red"), "intensity": .number(2)]) else {
            return XCTFail("clamp")
        }
        XCTAssertEqual(clamped.intensity, 1)
        guard case .colorAdjust(let c) = op("color_adjust", [
            "adjust": .array([.string("brighter"), .string("warmer")]),
            "intensity": .number(-1),
            "values": .object(["exposure_ev": .number(9), "contrast": .number(0.01)]),
        ]) else { return XCTFail("color_adjust") }
        XCTAssertEqual(c.intensity, 0)
        XCTAssertEqual(c.values.exposureEV, 3)
        XCTAssertEqual(c.values.contrast, 0.25)
        guard case .blurSharpen(let b) = op("blur_sharpen", [
            "mode": .string("motion_blur"), "angle_degrees": .number(900), "radius_px": .number(-4),
        ]) else { return XCTFail("blur") }
        XCTAssertEqual(b.angleDegrees, 180)
        XCTAssertEqual(b.radiusPx, 0)
    }

    func testCustomMatrixAndAudioPhotoRules() {
        let ok = [[1, 0, 0, 0, 0], [0, 1, 0, 0, 0], [0, 0, 1, 0, 0], [0, 0, 0, 1, 0]].map { row in
            JSONValue.array(row.map { .number($0) })
        }
        XCTAssertNotNil(op("channel_mixer", ["preset": .string("custom"), "matrix": .array(ok)]))
        XCTAssertTrue(isInvalid(plan("channel_mixer", ["preset": .string("custom")])))
        XCTAssertEqual(plan("audio_effect", ["effect": .string("reverb")], photo), .failure(.unsupportedForPhoto))
        var silent = video
        silent.hasAudio = false
        XCTAssertTrue(isInvalid(plan("audio_effect", ["effect": .string("reverb")], silent)))
        XCTAssertEqual(plan("segment", ["action": .string("blur_background"), "subject": .string("any")]), .failure(.unsupportedOnDevice))
        XCTAssertNotNil(op("segment", ["action": .string("blur_background"), "subject": .string("any")], photo))
        guard case .audioEffect(let a) = op("audio_effect", [
            "effect": .string("reverb"), "reverb_preset": .string("cathedral"), "mix_percent": .number(150),
        ]) else { return XCTFail("reverb") }
        XCTAssertEqual(a.reverbPreset, "cathedral")
        XCTAssertEqual(a.mixPercent, 100)
    }

    func testApplyFilterRoutesAliasesToOwningTools() {
        guard case .lut(let lut) = op("apply_filter", ["name": .string("noir"), "intensity": .number(0.8)]) else {
            return XCTFail("noir → lut")
        }
        XCTAssertEqual(lut.preset, "noir")
        XCTAssertEqual(lut.intensity, 0.8)
        guard case .colorFilter(let filter, let intensity) = op("apply_filter", ["name": .string("sepia")]) else {
            return XCTFail("sepia → apply_color_filter")
        }
        XCTAssertEqual(filter, "sepia")
        XCTAssertEqual(intensity, 1) // apply_color_filter default
        guard case .stylize(let st) = op("apply_filter", ["name": .string("comic")]) else {
            return XCTFail("comic → stylize")
        }
        XCTAssertEqual(st.preset, "comic")
        guard case .blurSharpen(let b) = op("apply_filter", ["name": .string("lens_blur")]) else {
            return XCTFail("lens_blur → blur_sharpen")
        }
        XCTAssertEqual(b.mode, "lens_blur")
        guard case .colorFilter(let vintage, _) = op("apply_filter", ["name": .string("transfer")]) else {
            return XCTFail("transfer → vintage")
        }
        XCTAssertEqual(vintage, "vintage")
    }

    func testLegacyAdjustToolsStillParse() {
        XCTAssertEqual(op("adjust_brightness", ["brightness": .number(0.2)]), .colorControls(brightness: 0.2, contrast: 1, saturation: 1))
        XCTAssertEqual(op("adjust_hue", ["degrees": .number(45)]), .hue(degrees: 45))
    }

    // MARK: - Rendering (synthetic image, server intensity / enum behaviour)

    private func bars() -> CIImage {
        // 200×100: left half red, right half blue.
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let img = UIGraphicsImageRenderer(size: CGSize(width: 200, height: 100), format: format).image { ctx in
            UIColor.red.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 100, height: 100))
            UIColor.blue.setFill(); ctx.fill(CGRect(x: 100, y: 0, width: 100, height: 100))
        }
        return CIImage(image: img)!
    }

    private func render(_ ops: [NativeOp], image: CIImage? = nil, time: Double = 0) -> CGImage {
        let source = image ?? bars()
        let renderer = FrameRenderer(ops: ops, sourceSize: source.extent.size)
        let out = renderer.apply(to: source, time: time)
        return context.createCGImage(out, from: out.extent)!
    }

    private func pixel(_ image: CGImage, _ x: Int, _ y: Int) -> (r: Int, g: Int, b: Int, a: Int) {
        var data = [UInt8](repeating: 0, count: 4)
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let ctx = CGContext(data: &data, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: space,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(image, in: CGRect(x: -x, y: -(image.height - 1 - y), width: image.width, height: image.height))
        return (Int(data[0]), Int(data[1]), Int(data[2]), Int(data[3]))
    }

    func testChannelMixerRemoveRedAndSwap() {
        let removed = render([.channelMixer(ChannelMixerOp(preset: "remove_red", intensity: 0.5, matrix: nil))])
        let left = pixel(removed, 25, 50)
        XCTAssertLessThan(left.r, 40, "red channel gone: \(left)")
        let right = pixel(removed, 150, 50)
        XCTAssertGreaterThan(right.b, 200)
        XCTAssertLessThan(right.r, 40)

        let swapped = render([.channelMixer(ChannelMixerOp(preset: "swap_rb", intensity: 0.5, matrix: nil))])
        let sl = pixel(swapped, 25, 50) // was red → blue
        XCTAssertGreaterThan(sl.b, sl.r + 80)
        let sr = pixel(swapped, 150, 50) // was blue → red
        XCTAssertGreaterThan(sr.r, sr.b + 80)
    }

    func testColorAdjustBrighterAndLutNoir() {
        let source = render([])
        let dark = pixel(source, 25, 50)
        let bright = render([.colorAdjust(ColorAdjustOp(
            adjust: ["brighter"], intensity: 0.8, intensityPerChange: [:], values: ColorAdjustValues()))])
        let after = pixel(bright, 25, 50)
        XCTAssertGreaterThan(after.r + after.g + after.b, dark.r + dark.g + dark.b)

        let noir = render([.lut(LutOp(preset: "noir", intensity: 0.5))])
        let p = pixel(noir, 25, 50)
        XCTAssertLessThanOrEqual(max(p.r, p.g, p.b) - min(p.r, p.g, p.b), 20, "noir is nearly gray: \(p)")
    }

    func testVignetteDarkensCornersAndBlurChangesPixels() {
        let source = render([])
        let mid = pixel(source, 100, 50)
        let vignette = render([.vignetteGrain(VignetteGrainOp(effect: "vignette", intensity: 1, vignetteAmount: nil, grainAmount: nil))])
        let corner = pixel(vignette, 2, 2)
        let center = pixel(vignette, 100, 50)
        XCTAssertLessThan(corner.r + corner.g + corner.b, mid.r + mid.g + mid.b)
        XCTAssertGreaterThan(center.r + center.g + center.b, corner.r + corner.g + corner.b)

        let blurred = render([.blurSharpen(BlurSharpenOp(mode: "blur", intensity: 1, angleDegrees: nil, centerX: nil, centerY: nil, radiusPx: 20))])
        // The hard red/blue edge at x=100 should be mixed.
        let edge = pixel(blurred, 100, 50)
        XCTAssertGreaterThan(edge.r, 20)
        XCTAssertGreaterThan(edge.b, 20)
    }

    func testStylizeAndApplyFilterRender() {
        let poster = render([.stylize(StylizeOp(preset: "posterize", intensity: 0.5, color: nil))])
        XCTAssertEqual([poster.width, poster.height], [200, 100])
        let twirl = render([.applyFilter(ApplyFilterOp(name: "twirl", intensity: 0.5, centerX: 0.5, centerY: 0.5, color: nil, color2: nil, params: [:]))])
        XCTAssertEqual([twirl.width, twirl.height], [200, 100])
        let cinematic = render([.lut(LutOp(preset: "cinematic", intensity: 0.5))])
        XCTAssertEqual([cinematic.width, cinematic.height], [200, 100])
        let splash = render([.stylize(StylizeOp(preset: "color_splash", intensity: 0.5, color: "red"))])
        let left = pixel(splash, 25, 50)
        XCTAssertGreaterThan(left.r, left.b + 40)
    }

    func testSegmentWithoutPersonTreatsWholeFrameAsBackground() {
        let popped = render([.segment(SegmentOp(action: "color_pop", subject: "person", backgroundColor: nil, intensity: 0.5))])
        let p = pixel(popped, 25, 50)
        XCTAssertLessThanOrEqual(max(p.r, p.g, p.b) - min(p.r, p.g, p.b), 20, "no person → whole frame desaturated: \(p)")
    }

    func testEditStackIsNonDestructive() {
        var stack = EditStack(base: URL(fileURLWithPath: "/tmp/base.jpg"), baseCanvas: photo)
        stack.push(EditEntry(tool: "color_adjust", op: .colorAdjust(ColorAdjustOp(
            adjust: ["brighter"], intensity: 0.5, intensityPerChange: [:], values: ColorAdjustValues()))))
        stack.push(EditEntry(tool: "lut", op: .lut(LutOp(preset: "chrome", intensity: 0.5))))
        XCTAssertEqual(stack.entries.count, 2)
        XCTAssertEqual(stack.base.path, "/tmp/base.jpg")
        XCTAssertTrue(stack.undo())
        XCTAssertEqual(stack.entries.count, 1)
        XCTAssertTrue(stack.redo())
        XCTAssertEqual(stack.entries.count, 2)
    }

    func testTelephoneMixAmountFollowsIntensityCurveAndOverride() {
        XCTAssertEqual(GroupedAudioRenderer.telephoneMixAmount(intensity: 0.25, mixPercent: nil), 0.5, accuracy: 0.0001)
        XCTAssertEqual(GroupedAudioRenderer.telephoneMixAmount(intensity: 0.5, mixPercent: nil), 1.0, accuracy: 0.0001)
        XCTAssertEqual(GroupedAudioRenderer.telephoneMixAmount(intensity: 1, mixPercent: nil), 1.0, accuracy: 0.0001)
        XCTAssertEqual(GroupedAudioRenderer.telephoneMixAmount(intensity: 0.5, mixPercent: 40), 0.4, accuracy: 0.0001)
        XCTAssertEqual(GroupedAudioRenderer.telephoneMixAmount(intensity: 0.5, mixPercent: 200), 1.0, accuracy: 0.0001)
        XCTAssertEqual(GroupedAudioRenderer.telephoneMixAmount(intensity: 0.5, mixPercent: -10), 0.0, accuracy: 0.0001)
    }

    func testMakeProjectKeepsGroupedVisualAndAudioOps() {
        let url = URL(fileURLWithPath: "/tmp/base.mov")
        var stack = EditStack(base: url, baseCanvas: video)
        let color = ColorAdjustOp(adjust: ["brighter"], intensity: 0.5, intensityPerChange: [:], values: ColorAdjustValues())
        let lut = LutOp(preset: "noir", intensity: 0.5)
        let mixer = ChannelMixerOp(preset: "remove_red", intensity: 0.5, matrix: nil)
        let filter = ApplyFilterOp(name: "twirl", intensity: 0.5, centerX: 0.5, centerY: 0.5, color: nil, color2: nil, params: [:])
        let stylize = StylizeOp(preset: "posterize", intensity: 0.5, color: nil)
        let blur = BlurSharpenOp(mode: "blur", intensity: 1, angleDegrees: nil, centerX: nil, centerY: nil, radiusPx: 8)
        let vignette = VignetteGrainOp(effect: "vignette", intensity: 1, vignetteAmount: nil, grainAmount: nil)
        let segment = SegmentOp(action: "color_pop", subject: "person", backgroundColor: nil, intensity: 0.5)
        let telephone = AudioEffectOp(effect: "telephone", intensity: 0.5, reverbPreset: nil, pitchSemitones: nil,
                                      delaySeconds: nil, mixPercent: nil, gainDb: nil, frequencyHz: nil)
        stack.push(EditEntry(tool: "color_adjust", op: .colorAdjust(color)))
        stack.push(EditEntry(tool: "lut", op: .lut(lut)))
        stack.push(EditEntry(tool: "channel_mixer", op: .channelMixer(mixer)))
        stack.push(EditEntry(tool: "apply_filter", op: .applyFilter(filter)))
        stack.push(EditEntry(tool: "stylize", op: .stylize(stylize)))
        stack.push(EditEntry(tool: "blur_sharpen", op: .blurSharpen(blur)))
        stack.push(EditEntry(tool: "vignette_grain", op: .vignetteGrain(vignette)))
        stack.push(EditEntry(tool: "segment", op: .segment(segment)))
        stack.push(EditEntry(tool: "audio_effect", op: .audioEffect(telephone)))
        let clip = stack.makeProject().videoClips[0]
        XCTAssertEqual(clip.effects.map(\.nativeOp), [
            .colorAdjust(color), .lut(lut), .channelMixer(mixer), .applyFilter(filter),
            .stylize(stylize), .blurSharpen(blur), .vignetteGrain(vignette), .segment(segment),
        ])
        XCTAssertEqual(clip.audioEffects, [telephone])
    }

    func testVideoClipDecodesWhenAudioEffectsKeyIsMissing() throws {
        var project = EditorProject(name: "Legacy", canvas: ProjectCanvas(width: 1280, height: 720))
        let asset = MediaAsset(id: UUID(), relativePath: "placeholder", name: "clip.mov", mediaType: .video,
                               duration: .seconds(6), naturalSize: CodableSize(width: 1280, height: 720),
                               preferredTransform: .identity, nominalFrameRate: 30, hasAudio: true)
        project.assets = [asset]
        project.videoClips = [VideoClip(id: UUID(), assetID: asset.id, sourceStart: .zero, sourceEnd: .seconds(6))]
        var root = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(project)) as? [String: Any])
        var clips = try XCTUnwrap(root["videoClips"] as? [[String: Any]])
        clips[0].removeValue(forKey: "audioEffects")
        root["videoClips"] = clips
        let loaded = try JSONDecoder().decode(EditorProject.self, from: JSONSerialization.data(withJSONObject: root))
        XCTAssertNil(loaded.videoClips[0].audioEffects)
        XCTAssertEqual(loaded.videoClips[0].effects, [])
    }

    func testPitchDownAlwaysLowersAndPitchUpAlwaysRaises() {
        // Default at intensity 0.5 is 6 semitones; sign follows the effect name.
        XCTAssertEqual(GroupedAudioRenderer.signedPitchSemitones(effect: "pitch_up", intensity: 0.5, pitchSemitones: nil), 6)
        XCTAssertEqual(GroupedAudioRenderer.signedPitchSemitones(effect: "pitch_down", intensity: 0.5, pitchSemitones: nil), -6)
        // Explicit values keep their magnitude, but pitch_down cannot pitch up.
        XCTAssertEqual(GroupedAudioRenderer.signedPitchSemitones(effect: "pitch_up", intensity: 0.5, pitchSemitones: 3), 3)
        XCTAssertEqual(GroupedAudioRenderer.signedPitchSemitones(effect: "pitch_down", intensity: 0.5, pitchSemitones: 3), -3)
        XCTAssertEqual(GroupedAudioRenderer.signedPitchSemitones(effect: "pitch_up", intensity: 0.5, pitchSemitones: -4), 4)
        XCTAssertEqual(GroupedAudioRenderer.signedPitchSemitones(effect: "pitch_down", intensity: 0.5, pitchSemitones: -4), -4)
    }

    func testGrainPatternChangesWithTime() {
        let ops: [NativeOp] = [.vignetteGrain(VignetteGrainOp(effect: "grain", intensity: 1, vignetteAmount: nil, grainAmount: nil))]
        let atZero = render(ops, time: 0)
        let later = render(ops, time: 1)
        XCTAssertNotEqual(checksum(atZero), checksum(later), "grain must be reseeded for later frames")
        // The untimed apply() overload is time 0 — composers must pass composition time.
        let source = bars()
        let renderer = FrameRenderer(ops: ops, sourceSize: source.extent.size)
        let untimedImage = renderer.apply(to: source)
        let untimed = context.createCGImage(untimedImage, from: untimedImage.extent)!
        XCTAssertEqual(checksum(untimed), checksum(atZero))
    }

    private func checksum(_ image: CGImage) -> Int {
        var total = 0
        for y in stride(from: 0, to: image.height, by: 5) {
            for x in stride(from: 0, to: image.width, by: 5) {
                let p = pixel(image, x, y)
                total = total &+ p.r &* 3 &+ p.g &* 5 &+ p.b &* 7 &+ x &+ y &* 13
            }
        }
        return total
    }
}
