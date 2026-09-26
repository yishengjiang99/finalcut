#if DEBUG
import AVFoundation
import CoreImage
import SwiftUI
import UIKit

/// DEBUG-only App Store screenshot fixtures (ASC first pass, build 11 UI).
///
/// Launch with `-ScreenshotState <name>` (see `ScreenshotState`). The app then:
/// - skips `AppModel.bootstrap()` entirely: no network, no device session, no quota fetch,
///   so the free-edit counter stays hidden and the paywall never opens by itself;
/// - seeds the Editor with the bundled sample clip, canned chat messages and edit-card-style
///   rows, and a clip rendered on the device with the state's look baked in.
///
/// Build 11 edits run on the server, so the preview effects here are rendered locally with
/// AVFoundation + Core Image into a short temp .mp4 (trim, title, color look, compare split).
/// Nothing here ships: the whole file is compiled out of Release.
///
/// Hooks (keep them tiny so they re-apply on top of the native Editor):
/// - `AppModel.bootstrap()`: `if ScreenshotFixtures.isActive { return }`
/// - `EditorView.onAppear`: `ScreenshotFixtures.applyIfRequested(to: model)`
enum ScreenshotState: String, CaseIterable {
    /// 1. Editor with the sample clip and a prompt typed in the composer.
    case editor
    /// 2. Chat with an applied edit card (trim).
    case editCard = "edit-card"
    /// 3. Compare: split between original and edited (baked into the preview clip).
    case compare
    /// 4. Title text on the preview.
    case title
    /// 5. Color look applied.
    case colorLook = "color-look"
    /// 6. Export sheet (the UI test taps Export).
    case export
}

@MainActor
enum ScreenshotFixtures {
    static let launchArgument = "-ScreenshotState"

    /// Requested state from `-ScreenshotState <name>` (also readable as a user default).
    static var requested: ScreenshotState? {
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: launchArgument), i + 1 < args.count {
            return ScreenshotState(rawValue: args[i + 1])
        }
        return UserDefaults.standard.string(forKey: "ScreenshotState").flatMap(ScreenshotState.init(rawValue:))
    }

    static var isActive: Bool { requested != nil }

    private static var didApply = false

    /// Seeds the Editor for the requested state. No-op without the launch argument.
    static func applyIfRequested(to model: EditorViewModel) {
        guard let state = requested, !didApply else { return }
        didApply = true
        UIView.setAnimationsEnabled(false)
        model.apiClient = nil
        model.showSampleChips = false // main's chips include translate / burn-in (not claimed in the listing)
        model.state = .processing
        model.processingOverlay = .editing
        Task { @MainActor in
            let clip = await renderClip(for: state)
            model.localVideoURL = clip
            model.state = .ready
            model.composerText = composerText(for: state)
            model.messages = messages(for: state)
        }
    }

    // MARK: - Canned chat

    static func composerText(for state: ScreenshotState) -> String {
        switch state {
        case .editor: return "Cut the first three seconds"
        default: return ""
        }
    }

    static func messages(for state: ScreenshotState) -> [ChatMessage] {
        func user(_ s: String) -> ChatMessage { ChatMessage(role: .user, content: s) }
        func card(_ s: String) -> ChatMessage { ChatMessage(role: .tool, content: s) }
        func bot(_ s: String) -> ChatMessage { ChatMessage(role: .assistant, content: s) }

        let trim = [
            user("Cut the first three seconds"),
            card("✂︎  Trim · starts at 0:03   ✓ Applied"),
            bot("Done. I cut the first three seconds, so the clip now opens on the action."),
        ]
        let warmer = [
            user("Make it warmer"),
            card("🎨  Color · Warmer   ✓ Applied"),
            bot("Made it warmer. Here's the original next to the edit."),
        ]
        let title = [
            user("Add a title that says Day One"),
            card("Aa  Title · “Day One”   ✓ Applied"),
            bot("Added “Day One” as a title over the opening."),
        ]
        let look = [
            user("Give it a warm film look"),
            card("🎞  Look · Warm film   ✓ Applied"),
            bot("Applied a warm film look with a soft vignette."),
        ]

        switch state {
        case .editor:
            return [ChatMessage(role: .system, content: "Loaded sample clip")]
        case .editCard:
            return trim
        case .compare:
            return warmer
        case .title:
            return trim + title
        case .colorLook:
            return title + look
        case .export:
            return title + look + [bot("Your video is ready. Tap Export to save it to Photos.")]
        }
    }

    /// Text the UI test waits for before capturing (last canned message).
    static func readyMarker(for state: ScreenshotState) -> String {
        messages(for: state).last?.content ?? ""
    }

    /// Renders the state's preview clip on the device (AVFoundation + Core Image).
    /// Falls back to the untouched sample clip if anything fails.
    static func renderClip(for state: ScreenshotState) async -> URL? {
        guard let source = ScreenshotClipRenderer.sampleClipURL else { return nil }
        guard let recipe = ScreenshotClipRenderer.recipe(for: state) else { return source }
        do {
            return try await ScreenshotClipRenderer.render(source: source, recipe: recipe)
        } catch {
            NSLog("ScreenshotFixtures: render failed (\(error)); using the untouched sample clip")
            return source
        }
    }
}

/// Renders the fixture clips off the main actor.
enum ScreenshotClipRenderer {

    /// Prefer a nicer hero clip if one is bundled later; fall back to main's test clip.
    static var sampleClipURL: URL? {
        Bundle.main.url(forResource: "screenshot-hero", withExtension: "mp4")
            ?? Bundle.main.url(forResource: "finalcap-test-video", withExtension: "mp4")
    }

    struct Recipe {
        var fileName: String
        var trimStart: Double = 0
        var look = false
        var title: String?
        var compare = false
    }

    static func recipe(for state: ScreenshotState) -> Recipe? {
        switch state {
        case .editor: return nil // the untouched sample clip, exactly like "Try the sample clip"
        case .editCard: return Recipe(fileName: "finalcap-trimmed.mp4", trimStart: 3)
        case .compare: return Recipe(fileName: "finalcap-compare.mp4", look: true, compare: true)
        case .title: return Recipe(fileName: "finalcap-day-one.mp4", trimStart: 3, title: "Day One")
        case .colorLook: return Recipe(fileName: "finalcap-warm-film.mp4", look: true, title: "Day One")
        case .export: return Recipe(fileName: "finalcap-day-one.mp4", look: true, title: "Day One")
        }
    }

    static func render(source: URL, recipe: Recipe) async throws -> URL {
        let asset = AVURLAsset(url: source)
        let duration = try await asset.load(.duration)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else {
            throw CocoaError(.fileReadCorruptFile)
        }
        let (natural, transform) = try await track.load(.naturalSize, .preferredTransform)
        let oriented = natural.applying(transform)
        let size = CGSize(width: abs(oriented.width), height: abs(oriented.height))

        let overlay: CIImage? = {
            guard recipe.title != nil || recipe.compare else { return nil }
            return overlayImage(size: size, title: recipe.title, compare: recipe.compare)
        }()
        let extent = CGRect(origin: .zero, size: size)
        let look = recipe.look

        let composition = AVMutableVideoComposition(asset: asset) { request in
            let original = request.sourceImage.clampedToExtent().cropped(to: extent)
            var output = look ? warmFilm(original, extent: extent) : original
            if recipe.compare {
                let right = CGRect(x: extent.midX, y: 0, width: extent.width / 2, height: extent.height)
                output = output.cropped(to: right).composited(over: original)
            }
            if let overlay { output = overlay.composited(over: output) }
            request.finish(with: output.cropped(to: extent), context: nil)
        }

        let out = FileManager.default.temporaryDirectory
            .appendingPathComponent("ScreenshotFixtures", isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let url = out.appendingPathComponent(recipe.fileName)
        try? FileManager.default.removeItem(at: url)

        guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetHighestQuality) else {
            throw CocoaError(.featureUnsupported)
        }
        session.outputURL = url
        session.outputFileType = .mp4
        session.videoComposition = composition
        let start = CMTime(seconds: recipe.trimStart, preferredTimescale: 600)
        session.timeRange = CMTimeRange(start: start, end: duration)
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            session.exportAsynchronously {
                if session.status == .completed {
                    cont.resume()
                } else {
                    cont.resume(throwing: session.error ?? CocoaError(.fileWriteUnknown))
                }
            }
        }
        return url
    }

    /// "Warm film": warmer white balance, a little more contrast and saturation, soft vignette.
    static func warmFilm(_ image: CIImage, extent: CGRect) -> CIImage {
        image
            .applyingFilter("CITemperatureAndTint", parameters: [
                "inputNeutral": CIVector(x: 6500, y: 0),
                "inputTargetNeutral": CIVector(x: 4300, y: 10),
            ])
            .applyingFilter("CIColorControls", parameters: [
                kCIInputSaturationKey: 1.15,
                kCIInputContrastKey: 1.08,
                kCIInputBrightnessKey: 0.02,
            ])
            .applyingFilter("CIVignette", parameters: [
                kCIInputIntensityKey: 1.1,
                kCIInputRadiusKey: 1.6,
            ])
            .cropped(to: extent)
    }

    /// Full-frame transparent overlay: optional title, optional compare divider + labels.
    private static func overlayImage(size: CGSize, title: String?, compare: Bool) -> CIImage? {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        let image = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            let cg = ctx.cgContext
            if let title {
                let fontSize = size.height * 0.16
                let font = UIFont.systemFont(ofSize: fontSize, weight: .heavy)
                let rounded = font.fontDescriptor.withDesign(.rounded).map { UIFont(descriptor: $0, size: fontSize) } ?? font
                let shadow = NSShadow()
                shadow.shadowColor = UIColor.black.withAlphaComponent(0.65)
                shadow.shadowBlurRadius = fontSize * 0.18
                shadow.shadowOffset = CGSize(width: 0, height: fontSize * 0.04)
                let para = NSMutableParagraphStyle()
                para.alignment = .center
                let attrs: [NSAttributedString.Key: Any] = [
                    .font: rounded,
                    .foregroundColor: UIColor.white,
                    .shadow: shadow,
                    .paragraphStyle: para,
                    .kern: fontSize * 0.02,
                ]
                let str = NSAttributedString(string: title, attributes: attrs)
                let textSize = str.boundingRect(with: size, options: .usesLineFragmentOrigin, context: nil).size
                // Dark band behind the title so it reads on any footage.
                let band = CGRect(x: 0, y: size.height * 0.62 - textSize.height * 0.25,
                                  width: size.width, height: textSize.height * 1.5)
                cg.setFillColor(UIColor.black.withAlphaComponent(0.35).cgColor)
                cg.fill(band)
                str.draw(in: CGRect(x: 0, y: size.height * 0.62, width: size.width, height: textSize.height))
            }
            if compare {
                let lineWidth = max(4, size.width * 0.005)
                cg.setFillColor(UIColor.white.cgColor)
                cg.fill(CGRect(x: size.width / 2 - lineWidth / 2, y: 0, width: lineWidth, height: size.height))
                let knob = size.height * 0.09
                cg.fillEllipse(in: CGRect(x: size.width / 2 - knob / 2, y: size.height / 2 - knob / 2, width: knob, height: knob))
                cg.setFillColor(UIColor.black.withAlphaComponent(0.6).cgColor)
                let chevrons = NSAttributedString(string: "‹ ›", attributes: [
                    .font: UIFont.systemFont(ofSize: knob * 0.5, weight: .bold),
                    .foregroundColor: UIColor.black,
                ])
                let cs = chevrons.size()
                chevrons.draw(at: CGPoint(x: size.width / 2 - cs.width / 2, y: size.height / 2 - cs.height / 2))
                drawPill("Original", at: CGPoint(x: size.width * 0.04, y: size.height * 0.06), anchorRight: false, size: size, in: cg)
                drawPill("Edited", at: CGPoint(x: size.width * 0.96, y: size.height * 0.06), anchorRight: true, size: size, in: cg)
            }
        }
        guard let cgImage = image.cgImage else { return nil }
        return CIImage(cgImage: cgImage)
    }

    private static func drawPill(_ text: String, at origin: CGPoint, anchorRight: Bool, size: CGSize, in cg: CGContext) {
        let fontSize = size.height * 0.055
        let str = NSAttributedString(string: text, attributes: [
            .font: UIFont.systemFont(ofSize: fontSize, weight: .semibold),
            .foregroundColor: UIColor.white,
        ])
        let ts = str.size()
        let padX = fontSize * 0.7, padY = fontSize * 0.35
        let w = ts.width + padX * 2, h = ts.height + padY * 2
        let x = anchorRight ? origin.x - w : origin.x
        let rect = CGRect(x: x, y: origin.y, width: w, height: h)
        cg.setFillColor(UIColor.black.withAlphaComponent(0.6).cgColor)
        cg.addPath(UIBezierPath(roundedRect: rect, cornerRadius: h / 2).cgPath)
        cg.fillPath()
        str.draw(at: CGPoint(x: rect.minX + padX, y: rect.minY + padY))
    }
}
#endif
