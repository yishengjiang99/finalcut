import Foundation
import ImageIO
import UniformTypeIdentifiers

/// On-device photo normalisation before anything is uploaded.
///
/// Prod FFmpeg (4.4) has no HEIF decoder and ignores EXIF orientation, so every photo the
/// app keeps is JPEG or PNG with the orientation baked into the pixels. HEIC/HEIF (and any
/// other still format) becomes an upright JPEG; a photo never uploads as HEIC.
enum PhotoTranscoder {
    enum TranscodeError: Error, Equatable {
        /// ImageIO couldn't decode the file.
        case unreadable
        /// Encoding the JPEG failed.
        case encodeFailed
    }

    /// Formats the server reads directly (after orientation is normalised).
    static let passthroughExtensions: Set<String> = ["jpg", "jpeg", "png"]
    /// Formats that must never be uploaded.
    static let forbiddenUploadMIMEs: Set<String> = ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"]

    static let jpegQuality: CGFloat = 0.92

    /// EXIF orientation (1…8) of the first image, or nil if unreadable.
    static func orientation(of url: URL) -> Int? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else { return nil }
        return (props[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
    }

    static func decodedType(of url: URL) -> UTType? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let typeID = CGImageSourceGetType(source) as String? else { return nil }
        return UTType(typeID)
    }

    /// Pixel size as displayed (orientation applied).
    static func orientedPixelSize(of url: URL) -> (width: Int, height: Int)? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let w = (props[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let h = (props[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue else { return nil }
        let orientation = (props[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
        return (5...8).contains(orientation) ? (h, w) : (w, h)
    }

    /// True when `url` must be rewritten before upload/preview (not JPEG/PNG, or rotated via EXIF).
    /// The decision uses the decoded container type, not just the filename, so HEIC bytes
    /// behind a `.jpg` name are still converted.
    static func needsNormalization(_ url: URL) -> Bool {
        let ext = url.pathExtension.lowercased()
        guard passthroughExtensions.contains(ext),
              let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let typeID = CGImageSourceGetType(source) as String?,
              let type = UTType(typeID) else { return true }
        let isJPEG = type.conforms(to: .jpeg)
        let isPNG = type.conforms(to: .png)
        guard (isJPEG && ext != "png") || (isPNG && ext == "png") else { return true }
        return (orientation(of: url) ?? 1) != 1
    }

    /// Returns a JPEG/PNG with orientation 1 for `url`. Passthrough files are returned as-is.
    /// Otherwise writes `<name>.jpg` (or `.png` for rotated PNGs) next to the source and
    /// deletes the source when `replace` is true.
    static func normalizedPhoto(at url: URL, replace: Bool = true) throws -> URL {
        guard needsNormalization(url) else { return url }
        let keepPNG = url.pathExtension.lowercased() == "png" && decodedType(of: url)?.conforms(to: .png) == true
        let data = try uprightData(fromImageAt: url, as: keepPNG ? .png : .jpeg)
        let out = url.deletingPathExtension().appendingPathExtension(keepPNG ? "png" : "jpg")
        // Same name (case-insensitively, for case-insensitive volumes) → write a sibling instead.
        let clashes = out.path.lowercased() == url.path.lowercased()
        let destination = clashes ? url.deletingLastPathComponent()
            .appendingPathComponent(url.deletingPathExtension().lastPathComponent + "-upright." + (keepPNG ? "png" : "jpg")) : out
        try data.write(to: destination, options: .atomic)
        if replace { try? FileManager.default.removeItem(at: url) }
        return destination
    }

    /// Decodes the first image, applies its EXIF orientation to the pixels and encodes it.
    /// GPS metadata is dropped; the colour profile rides along with the CGImage.
    static func uprightData(fromImageAt url: URL, as type: UTType = .jpeg) throws -> Data {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              CGImageSourceGetCount(source) > 0,
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let w = (props[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let h = (props[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue else {
            throw TranscodeError.unreadable
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: max(w, h),
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            throw TranscodeError.unreadable
        }
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data as CFMutableData, type.identifier as CFString, 1, nil) else {
            throw TranscodeError.encodeFailed
        }
        var outProps: [CFString: Any] = [kCGImagePropertyOrientation: 1]
        if type == .jpeg { outProps[kCGImageDestinationLossyCompressionQuality] = jpegQuality }
        if var exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any] {
            exif.removeValue(forKey: kCGImagePropertyExifPixelXDimension)
            exif.removeValue(forKey: kCGImagePropertyExifPixelYDimension)
            outProps[kCGImagePropertyExifDictionary] = exif
        }
        if var tiff = props[kCGImagePropertyTIFFDictionary] as? [CFString: Any] {
            tiff[kCGImagePropertyTIFFOrientation] = 1
            outProps[kCGImagePropertyTIFFDictionary] = tiff
        }
        CGImageDestinationAddImage(dest, image, outProps as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { throw TranscodeError.encodeFailed }
        return data as Data
    }

    /// Upload guard: a copy of the photo that is safe to send (JPEG/PNG, upright).
    /// Never returns a HEIC/HEIF URL.
    static func uploadablePhoto(at url: URL) throws -> URL {
        let result = needsNormalization(url) ? try normalizedPhoto(at: url, replace: false) : url
        if forbiddenUploadMIMEs.contains(MediaMIME.mimeType(for: result)) {
            throw TranscodeError.unreadable
        }
        return result
    }
}
