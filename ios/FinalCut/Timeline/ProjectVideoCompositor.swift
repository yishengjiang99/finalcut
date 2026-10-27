import AVFoundation
import CoreImage
import CoreMedia
import Foundation

/// One video-composition instruction for the project timeline: the layers active over
/// `timeRange`, each with its clip's effect renderer, source geometry and opacity ramp.
/// During a cut interval there is exactly one layer; during a cross-dissolve there are
/// two, and the compositor blends both source frames (which is why the project path
/// needs a custom compositor — the single-source CI handler cannot see two frames).
final class ProjectCompositionInstruction: NSObject, AVVideoCompositionInstructionProtocol {
    struct Layer {
        var trackID: CMPersistentTrackID
        var renderer: FrameRenderer
        var naturalSize: CGSize
        var transform: CGAffineTransform
        var orientedSize: CGSize
        var opacityStart: Float
        var opacityEnd: Float

        func opacity(at time: CMTime, in range: CMTimeRange) -> Float {
            let duration = CMTimeGetSeconds(range.duration)
            guard duration > 0 else { return opacityEnd }
            let t = min(1, max(0, CMTimeGetSeconds(CMTimeSubtract(time, range.start)) / duration))
            return opacityStart + (opacityEnd - opacityStart) * Float(t)
        }
    }

    var timeRange: CMTimeRange
    var enablePostProcessing = true
    var containsTweening = true
    var requiredSourceTrackIDs: [NSValue]?
    var passthroughTrackID: CMPersistentTrackID = kCMPersistentTrackID_Invalid

    let layers: [Layer]
    let canvasSize: CGSize
    let fit: CanvasFit
    /// Project-time captions, drawn once over the composited frame.
    let captions: [CaptionCue]
    let captionRenderer: FrameRenderer

    init(timeRange: CMTimeRange, layers: [Layer], canvasSize: CGSize, fit: CanvasFit, captions: [CaptionCue]) {
        self.timeRange = timeRange
        self.layers = layers
        self.canvasSize = canvasSize
        self.fit = fit
        self.captions = captions
        self.requiredSourceTrackIDs = layers.map { NSNumber(value: $0.trackID) }
        self.captionRenderer = FrameRenderer(ops: [], sourceSize: canvasSize, captions: captions)
        super.init()
    }
}

/// Custom `AVVideoCompositing` for project compositions. Renders each layer's frame
/// (orientation-normalise → the clip's Core Image effect chain → fit into the project
/// canvas), applies the layer opacity, composites over black, then draws the active
/// project caption. The same code path serves preview and export.
final class ProjectVideoCompositor: NSObject, AVVideoCompositing {
    var sourcePixelBufferAttributes: [String: Any]? = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    ]
    var requiredPixelBufferAttributesForRenderContext: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    ]

    private var renderContext: AVVideoCompositionRenderContext?
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])

    func renderContextChanged(_ newRenderContext: AVVideoCompositionRenderContext) {
        renderContext = newRenderContext
    }

    func startRequest(_ request: AVAsynchronousVideoCompositionRequest) {
        guard let instruction = request.videoCompositionInstruction as? ProjectCompositionInstruction,
              let context = renderContext else {
            request.finish(with: NSError(domain: "ProjectVideoCompositor", code: 1,
                                         userInfo: [NSLocalizedDescriptionKey: "missing instruction or render context"]))
            return
        }
        let canvas = instruction.canvasSize
        var output = CIImage(color: .black).cropped(to: CGRect(origin: .zero, size: canvas))
        for layer in instruction.layers {
            guard let buffer = request.sourceFrame(byTrackID: layer.trackID) else { continue }
            var image = CIImage(cvPixelBuffer: buffer)
            // Normalise orientation exactly like the single-clip handler: if the frame
            // arrives in natural (unrotated) space, apply the source transform once.
            if layer.transform != .identity,
               abs(image.extent.width - layer.naturalSize.width) < 1,
               abs(image.extent.height - layer.naturalSize.height) < 1,
               abs(layer.naturalSize.width - layer.orientedSize.width) > 1 {
                image = image.transformed(by: layer.transform)
            }
            image = image.transformed(by: CGAffineTransform(translationX: -image.extent.origin.x, y: -image.extent.origin.y))
            // Clip effects (in oriented source space).
            image = layer.renderer.apply(to: image)
            // Fit the rendered frame into the project canvas without distortion.
            let frameSize = image.extent.size
            guard frameSize.width > 0, frameSize.height > 0 else { continue }
            let scaleX = canvas.width / frameSize.width
            let scaleY = canvas.height / frameSize.height
            let scale = instruction.fit == .aspectFill ? max(scaleX, scaleY) : min(scaleX, scaleY)
            let dx = (canvas.width - frameSize.width * scale) / 2
            let dy = (canvas.height - frameSize.height * scale) / 2
            image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale)
                .concatenating(CGAffineTransform(translationX: dx, y: dy)))
            let opacity = layer.opacity(at: request.compositionTime, in: instruction.timeRange)
            if opacity < 0.999 {
                image = image.applyingFilter("CIColorMatrix", parameters: [
                    "inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(max(0, opacity))),
                ])
            }
            if opacity > 0.001 {
                output = image.cropped(to: CGRect(origin: .zero, size: canvas)).composited(over: output)
            }
        }
        // Project-time captions over the final composite.
        if !instruction.captions.isEmpty {
            output = instruction.captionRenderer.apply(to: output, time: CMTimeGetSeconds(request.compositionTime))
        }
        guard let pixelBuffer = context.newPixelBuffer() else {
            request.finish(with: NSError(domain: "ProjectVideoCompositor", code: 2,
                                         userInfo: [NSLocalizedDescriptionKey: "no render buffer"]))
            return
        }
        ciContext.render(output, to: pixelBuffer)
        request.finish(withComposedVideoFrame: pixelBuffer)
    }
}
