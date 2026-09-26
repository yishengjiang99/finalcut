import CoreImage
import CoreText
import Foundation
import UIKit

/// Applies the frame ops of an edit stack to one image with Core Image. The same chain
/// renders video frames (inside the `AVVideoComposition` handler) and photos, so preview,
/// thumbnails and export always match.
struct FrameRenderer: @unchecked Sendable {
    let ops: [NativeOp]
    let sourceSize: CGSize
    /// Pre-rendered text overlays keyed by op index (Core Text, rendered once per edit).
    private let textImages: [Int: CIImage]

    init(ops: [NativeOp], sourceSize: CGSize) {
        let frameOps = ops.filter(\.isFrame)
        self.ops = frameOps
        self.sourceSize = sourceSize
        var texts: [Int: CIImage] = [:]
        for (index, op) in frameOps.enumerated() {
            if case .text(let string, _, _, let size, let color) = op,
               let image = Self.renderText(string, fontSize: CGFloat(size), color: color) {
                texts[index] = image
            }
        }
        textImages = texts
    }

    /// Canvas size after all frame ops (even-rounded for H.264).
    var outputSize: CGSize {
        var size = sourceSize
        for op in ops {
            size = Self.size(after: op, from: size)
        }
        return size
    }

    static func size(after op: NativeOp, from size: CGSize) -> CGSize {
        switch op {
        case .crop(_, _, let w, let h), .resize(let w, let h), .pad(let w, let h):
            return CGSize(width: w, height: h)
        case .rotate(let degrees):
            if NativeCanvas.isQuarterTurn(degrees), Int((degrees / 90).rounded()) % 2 != 0 {
                return CGSize(width: size.height, height: size.width)
            }
            return size
        default:
            return size
        }
    }

    static func evenSize(_ size: CGSize) -> CGSize {
        CGSize(width: max(2, (Int(size.width.rounded()) / 2) * 2), height: max(2, (Int(size.height.rounded()) / 2) * 2))
    }

    /// Runs the chain. `image` must have its extent at the origin with size `sourceSize`.
    func apply(to input: CIImage) -> CIImage {
        var image = input.transformed(by: CGAffineTransform(translationX: -input.extent.origin.x, y: -input.extent.origin.y))
        var size = sourceSize
        for (index, op) in ops.enumerated() {
            image = Self.apply(op, to: image, size: size, text: textImages[index])
            size = Self.size(after: op, from: size)
            image = image.cropped(to: CGRect(origin: .zero, size: size))
        }
        let black = CIImage(color: .black).cropped(to: CGRect(origin: .zero, size: size))
        return image.composited(over: black)
    }

    private static func apply(_ op: NativeOp, to image: CIImage, size: CGSize, text: CIImage?) -> CIImage {
        let w = size.width, h = size.height
        switch op {
        case .crop(let x, let y, let cw, let ch):
            // Top-left origin → CI bottom-left.
            let ciY = h - CGFloat(y) - CGFloat(ch)
            return image
                .cropped(to: CGRect(x: CGFloat(x), y: ciY, width: CGFloat(cw), height: CGFloat(ch)))
                .transformed(by: CGAffineTransform(translationX: -CGFloat(x), y: -ciY))

        case .rotate(let degrees):
            // Clockwise positive (server convention) → CI counter-clockwise radians.
            let radians = -degrees * .pi / 180
            let rotated = image.transformed(by: CGAffineTransform(rotationAngle: radians))
            if NativeCanvas.isQuarterTurn(degrees) {
                return rotated.transformed(by: CGAffineTransform(translationX: -rotated.extent.origin.x, y: -rotated.extent.origin.y))
            }
            // Other angles: rotate about the centre on the same canvas (black fill).
            let centred = image
                .transformed(by: CGAffineTransform(translationX: -w / 2, y: -h / 2))
                .transformed(by: CGAffineTransform(rotationAngle: radians))
                .transformed(by: CGAffineTransform(translationX: w / 2, y: h / 2))
            return centred

        case .flipHorizontal:
            return image.transformed(by: CGAffineTransform(scaleX: -1, y: 1).concatenating(CGAffineTransform(translationX: w, y: 0)))

        case .flipVertical:
            return image.transformed(by: CGAffineTransform(scaleX: 1, y: -1).concatenating(CGAffineTransform(translationX: 0, y: h)))

        case .resize(let nw, let nh):
            return image.transformed(by: CGAffineTransform(scaleX: CGFloat(nw) / w, y: CGFloat(nh) / h))

        case .pad(let pw, let ph):
            let scale = min(CGFloat(pw) / w, CGFloat(ph) / h)
            let dx = (CGFloat(pw) - w * scale) / 2
            let dy = (CGFloat(ph) - h * scale) / 2
            let fitted = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale).concatenating(CGAffineTransform(translationX: dx, y: dy)))
            return fitted.composited(over: CIImage(color: .black).cropped(to: CGRect(x: 0, y: 0, width: pw, height: ph)))

        case .colorControls(let brightness, let contrast, let saturation):
            return image.applyingFilter("CIColorControls", parameters: [
                kCIInputBrightnessKey: brightness,
                kCIInputContrastKey: contrast,
                kCIInputSaturationKey: saturation,
            ])

        case .hue(let degrees):
            return image.applyingFilter("CIHueAdjust", parameters: [kCIInputAngleKey: degrees * .pi / 180])

        case .colorFilter(let filter, let intensity):
            return applyColorFilter(filter, intensity: intensity, to: image)

        case .text(_, let x, let y, _, _):
            guard let text else { return image }
            let ciY = h - CGFloat(y) - text.extent.height
            return text.transformed(by: CGAffineTransform(translationX: CGFloat(x), y: ciY)).composited(over: image)

        default:
            return image
        }
    }

    // MARK: - Colour filters (server `buildColorFilter` parity)

    static let identity: [Double] = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    static let sepia: [Double] = [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131]
    static let gray: [Double] = [0.299, 0.587, 0.114, 0.299, 0.587, 0.114, 0.299, 0.587, 0.114]

    static func tint(_ keep: (Bool, Bool, Bool)) -> [Double] {
        [keep.0 ? 1 : 0.4, 0, 0, 0, keep.1 ? 1 : 0.4, 0, 0, 0, keep.2 ? 1 : 0.4]
    }

    /// 3×3 row-major matrix for a preset, mixed with identity by `intensity`.
    static func matrix(for filter: String, intensity: Double) -> [Double]? {
        let target: [Double]
        switch filter {
        case "red": target = tint((true, false, false))
        case "green": target = tint((false, true, false))
        case "blue": target = tint((false, false, true))
        case "yellow": target = tint((true, true, false))
        case "cyan": target = tint((false, true, true))
        case "magenta": target = tint((true, false, true))
        case "sepia": target = sepia
        case "grayscale", "black_and_white": target = gray
        case "warm":
            // Colour-matrix channel gains (R up, B down), scaled by intensity.
            target = [1.15, 0, 0, 0, 1.0, 0, 0, 0, 0.85]
        case "cool":
            target = [0.85, 0, 0, 0, 1.0, 0, 0, 0, 1.15]
        default: return nil
        }
        return zip(identity, target).map { $0 * (1 - intensity) + $1 * intensity }
    }

    static func applyColorFilter(_ filter: String, intensity: Double, to image: CIImage) -> CIImage {
        switch filter {
        case "invert":
            let inverted = image.applyingFilter("CIColorInvert")
            return intensity >= 1 ? inverted : blend(inverted, over: image, amount: intensity)
        case "vintage":
            let vintage = image.applyingFilter("CIPhotoEffectTransfer")
            return intensity >= 1 ? vintage : blend(vintage, over: image, amount: intensity)
        default:
            guard let m = matrix(for: filter, intensity: intensity) else { return image }
            var out = image.applyingFilter("CIColorMatrix", parameters: [
                "inputRVector": CIVector(x: m[0], y: m[1], z: m[2], w: 0),
                "inputGVector": CIVector(x: m[3], y: m[4], z: m[5], w: 0),
                "inputBVector": CIVector(x: m[6], y: m[7], z: m[8], w: 0),
                "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 1),
                "inputBiasVector": CIVector(x: 0, y: 0, z: 0, w: 0),
            ])
            if filter == "black_and_white" {
                out = out.applyingFilter("CIColorControls", parameters: [kCIInputContrastKey: 1 + 0.6 * intensity])
            }
            return out
        }
    }

    private static func blend(_ top: CIImage, over bottom: CIImage, amount: Double) -> CIImage {
        let faded = top.applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: amount)])
        return faded.composited(over: bottom)
    }

    // MARK: - Text

    static func renderText(_ string: String, fontSize: CGFloat, color: RGBAColor) -> CIImage? {
        let font = UIFont.systemFont(ofSize: fontSize, weight: .semibold)
        let attributed = NSAttributedString(string: string, attributes: [
            .font: font,
            .foregroundColor: UIColor(cgColor: color.cgColor),
        ])
        let bounds = attributed.boundingRect(with: CGSize(width: 8192, height: 8192), options: [.usesLineFragmentOrigin], context: nil)
        let size = CGSize(width: ceil(bounds.width), height: ceil(bounds.height))
        guard size.width > 0, size.height > 0 else { return nil }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        let rendered = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            attributed.draw(with: CGRect(origin: .zero, size: size), options: [.usesLineFragmentOrigin], context: nil)
        }
        guard let cg = rendered.cgImage else { return nil }
        return CIImage(cgImage: cg)
    }
}
