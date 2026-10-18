import CoreImage
import CoreText
import Foundation
import UIKit

/// Noto Sans CJK SC Bold (bundled, SIL OFL; see Resources/NotoSansCJK-OFL.txt), registered
/// at first use. Falls back to PingFang SC Semibold, then the system bold font.
enum LyricCaptionFont {
    private static let registered: Bool = {
        guard let url = Bundle.main.url(forResource: "NotoSansCJKsc-Bold", withExtension: "otf") else { return false }
        var error: Unmanaged<CFError>?
        // Already-registered is fine; the font is then found by name below.
        _ = CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error)
        return true
    }()

    static func font(size: CGFloat) -> UIFont {
        _ = registered
        return UIFont(name: LyricCaptionStyle.primaryFontName, size: size)
            ?? UIFont(name: LyricCaptionStyle.fallbackFontName, size: size)
            ?? UIFont.systemFont(ofSize: size, weight: .bold)
    }

    /// PostScript name of the font that will actually be used.
    static var resolvedName: String { font(size: 12).fontName }
}

/// One caption block drawn for a canvas: white text, black outline and soft shadow,
/// bottom-center, anchored `positionFromBottomPct` up from the bottom. The same CIImage is
/// composited in the preview and the export (one Core Image chain), so they always match.
struct LyricCaptionImage {
    let image: CIImage
    /// Where the image's lower-left corner goes on the canvas (Core Image origin: bottom-left).
    let origin: CGPoint
}

enum LyricCaptionRenderer {
    static func render(_ line: LyricLine, canvas: CGSize, track: LyricCaptionTrack) -> LyricCaptionImage? {
        let string = line.displayText
        guard !string.isEmpty, canvas.width > 0, canvas.height > 0 else { return nil }
        let fontSize = LyricCaptionStyle.fontSize(canvasHeight: canvas.height, override: track.fontSize)
        let outline = LyricCaptionStyle.outlineWidth(canvasHeight: canvas.height)
        let shadow = LyricCaptionStyle.shadowOffset(canvasHeight: canvas.height)
        let margin = LyricCaptionStyle.horizontalMargin(canvasWidth: canvas.width)
        let width = max(2, (canvas.width - 2 * margin).rounded())
        let pad = ceil(outline * 2 + shadow * 3 + 2)

        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        paragraph.lineBreakMode = .byWordWrapping
        let font = LyricCaptionFont.font(size: CGFloat(fontSize))

        func attributed(_ extra: [NSAttributedString.Key: Any]) -> NSAttributedString {
            var attributes: [NSAttributedString.Key: Any] = [.font: font, .paragraphStyle: paragraph]
            for (key, value) in extra { attributes[key] = value }
            return NSAttributedString(string: string, attributes: attributes)
        }

        let shadowStyle = NSShadow()
        shadowStyle.shadowColor = UIColor.black.withAlphaComponent(0.5)
        shadowStyle.shadowOffset = CGSize(width: shadow, height: shadow)
        shadowStyle.shadowBlurRadius = shadow * 2
        // Stroke is centred on the glyph edge: twice the outline, then the fill covers the inner half.
        let strokePercent = 2 * outline / max(fontSize, 1) * 100
        let strokeCopy = attributed([
            .foregroundColor: UIColor.black,
            .strokeColor: UIColor.black,
            .strokeWidth: strokePercent,
            .shadow: shadowStyle,
        ])
        let fillCopy = attributed([.foregroundColor: UIColor.white])

        let bounds = fillCopy.boundingRect(with: CGSize(width: width, height: canvas.height),
                                           options: [.usesLineFragmentOrigin], context: nil)
        let textHeight = ceil(bounds.height)
        guard textHeight > 0 else { return nil }
        let size = CGSize(width: width, height: textHeight + 2 * pad)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        let rendered = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            let rect = CGRect(x: 0, y: pad, width: width, height: textHeight)
            strokeCopy.draw(with: rect, options: [.usesLineFragmentOrigin], context: nil)
            fillCopy.draw(with: rect, options: [.usesLineFragmentOrigin], context: nil)
        }
        guard let cg = rendered.cgImage else { return nil }
        let bottom = LyricCaptionStyle.bottomOffset(canvasHeight: canvas.height, pct: track.positionFromBottomPct)
        return LyricCaptionImage(image: CIImage(cgImage: cg), origin: CGPoint(x: margin.rounded(), y: bottom - pad))
    }
}
