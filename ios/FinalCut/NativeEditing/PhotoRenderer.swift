import CoreImage
import Foundation
import ImageIO
import UIKit
import UniformTypeIdentifiers

/// Photo edits run entirely on the device with Core Image (no upload, no HEIC conversion).
enum PhotoRenderer {
    enum RenderError: Error {
        case unreadable
        case encodeFailed
    }

    static let context = CIContext(options: [.cacheIntermediates: false])

    /// Source image with EXIF orientation applied, extent at the origin.
    static func sourceImage(_ url: URL) throws -> CIImage {
        guard let image = CIImage(contentsOf: url, options: [.applyOrientationProperty: true]) else {
            throw RenderError.unreadable
        }
        return image.transformed(by: CGAffineTransform(translationX: -image.extent.origin.x, y: -image.extent.origin.y))
    }

    static func render(_ stack: EditStack) throws -> CIImage {
        let source = try sourceImage(stack.base)
        let renderer = FrameRenderer(ops: stack.ops, sourceSize: source.extent.size)
        return renderer.apply(to: source)
    }

    /// Preview bitmap (longest side ≤ `maxDimension`).
    static func previewImage(_ stack: EditStack, maxDimension: CGFloat = 2048) throws -> UIImage {
        var image = try render(stack)
        let longest = max(image.extent.width, image.extent.height)
        if longest > maxDimension {
            let scale = maxDimension / longest
            image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        }
        guard let cg = context.createCGImage(image, from: image.extent) else { throw RenderError.encodeFailed }
        return UIImage(cgImage: cg)
    }

    /// Output format for export: an explicit `convert_image_format`, else the original.
    static func outputType(for stack: EditStack) -> UTType {
        switch stack.outputFormat {
        case "png": return .png
        case "jpg": return .jpeg
        default:
            let ext = stack.base.pathExtension.lowercased()
            if ext == "png" { return .png }
            if ext == "heic" || ext == "heif" { return .heic }
            return .jpeg
        }
    }

    /// Full-resolution encoded photo in the output format.
    static func exportData(_ stack: EditStack) throws -> (data: Data, type: UTType) {
        let image = try render(stack)
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let type = outputType(for: stack)
        let data: Data?
        switch type {
        case .png:
            data = context.pngRepresentation(of: image, format: .RGBA8, colorSpace: space)
        case .heic:
            data = context.heifRepresentation(of: image, format: .RGBA8, colorSpace: space)
                ?? context.jpegRepresentation(of: image, colorSpace: space)
        default:
            data = context.jpegRepresentation(of: image, colorSpace: space,
                                              options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.92])
        }
        guard let data else { throw RenderError.encodeFailed }
        return (data, type)
    }

    /// Writes the export to a temp file with the right extension.
    static func exportFile(_ stack: EditStack) throws -> URL {
        let (data, type) = try exportData(stack)
        let name = stack.base.deletingPathExtension().lastPathComponent + "-edited." + (type == .jpeg ? "jpg" : type.preferredFilenameExtension ?? "jpg")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        let out = url.appendingPathComponent(name)
        try data.write(to: out)
        return out
    }
}
