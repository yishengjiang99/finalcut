import AVFoundation
import CoreImage
import ImageIO
import UIKit

/// Joins photos (in pick order) into one 1080p H.264 slideshow with a silent audio track,
/// so the result is an ordinary video project (audio tools included).
enum SlideshowBuilder {
    static let fps: Int32 = 30
    static let secondsPerPhoto = 2.75
    static let crossfadeSeconds = 0.5

    struct Timing: Equatable {
        let framesPerPhoto: Int
        let fadeFrames: Int
        let photoCount: Int
        var totalFrames: Int { framesPerPhoto * photoCount }
        var duration: Double { Double(totalFrames) / Double(SlideshowBuilder.fps) }

        init(photoCount: Int) {
            self.photoCount = photoCount
            framesPerPhoto = Int((SlideshowBuilder.secondsPerPhoto * Double(SlideshowBuilder.fps)).rounded())
            fadeFrames = Int((SlideshowBuilder.crossfadeSeconds * Double(SlideshowBuilder.fps)).rounded())
        }

        /// Photo shown at `frame`, plus the next photo and its blend (0…1) during the
        /// crossfade at the end of each slot (none after the last photo).
        func layer(at frame: Int) -> (index: Int, next: Int?, mix: Double) {
            let index = min(frame / framesPerPhoto, photoCount - 1)
            let local = frame - index * framesPerPhoto
            let fadeStart = framesPerPhoto - fadeFrames
            guard index < photoCount - 1, local >= fadeStart else { return (index, nil, 0) }
            return (index, index + 1, Double(local - fadeStart + 1) / Double(fadeFrames + 1))
        }
    }

    /// 1080p canvas with the first photo's aspect, clamped between 9:16 and 16:9 (even sides).
    static func outputSize(forFirstPhoto size: CGSize?) -> CGSize {
        guard let size, size.width > 0, size.height > 0 else { return CGSize(width: 1080, height: 1920) }
        let aspect = min(max(size.width / size.height, 9.0 / 16.0), 16.0 / 9.0)
        func even(_ v: CGFloat) -> CGFloat { (v / 2).rounded() * 2 }
        return aspect >= 1 ? CGSize(width: even(1080 * aspect), height: 1080)
                           : CGSize(width: 1080, height: even(1080 / aspect))
    }

    /// Upright (EXIF orientation applied), downsampled image.
    static func uprightImage(at url: URL, maxPixelSize: CGFloat) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    /// Letterboxed (aspect-fit on black) frame for one photo.
    static func fittedFrame(_ image: CGImage, size: CGSize) -> CIImage {
        let ci = CIImage(cgImage: image)
        let scale = min(size.width / ci.extent.width, size.height / ci.extent.height)
        let scaled = ci.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let placed = scaled.transformed(by: CGAffineTransform(
            translationX: ((size.width - scaled.extent.width) / 2).rounded() - scaled.extent.minX,
            y: ((size.height - scaled.extent.height) / 2).rounded() - scaled.extent.minY))
        let rect = CGRect(origin: .zero, size: size)
        return placed.composited(over: CIImage(color: .black).cropped(to: rect)).cropped(to: rect)
    }

    enum BuildError: Error { case noPhotos, unreadable, writer(String) }

    /// Writes the slideshow to a new .mp4. `progress` gets 0…1 as frames are written.
    static func build(photos: [URL], progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws -> URL {
        guard let first = photos.first else { throw BuildError.noPhotos }
        let firstSize = PhotoTranscoder.orientedPixelSize(of: first).map { CGSize(width: $0.width, height: $0.height) }
        let size = outputSize(forFirstPhoto: firstSize)
        let frames: [CIImage] = try photos.map { url in
            guard let image = uprightImage(at: url, maxPixelSize: max(size.width, size.height)) else { throw BuildError.unreadable }
            return fittedFrame(image, size: size)
        }
        let timing = Timing(photoCount: frames.count)

        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ImportedVideos", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let output = directory.appendingPathComponent("Slideshow.mp4")

        let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
        let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: Int(size.width),
            AVVideoHeightKey: Int(size.height),
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 10_000_000,
                                              AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel],
        ])
        video.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: video, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: Int(size.width),
            kCVPixelBufferHeightKey as String: Int(size.height),
        ])
        let audio = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64_000,
        ])
        audio.expectsMediaDataInRealTime = false
        writer.add(video)
        writer.add(audio)
        guard writer.startWriting() else { throw BuildError.writer(writer.error?.localizedDescription ?? "start") }
        writer.startSession(atSourceTime: .zero)

        var silence = try Silence(total: Int(timing.duration * Double(Silence.rate)))
        let context = CIContext(options: [.cacheIntermediates: false])
        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
        for frame in 0..<timing.totalFrames {
            try Task.checkCancellation()
            // Interleave: keep silent audio up to this frame's time so the writer never stalls.
            try silence.feed(audio, upTo: Double(frame + 1) / Double(fps))
            while !video.isReadyForMoreMediaData {
                try silence.feed(audio, upTo: Double(frame + 1) / Double(fps))
                try await Task.sleep(nanoseconds: 2_000_000)
            }
            guard let pool = adaptor.pixelBufferPool else { throw BuildError.writer("pool") }
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
            guard let buffer else { throw BuildError.writer("buffer") }
            let layer = timing.layer(at: frame)
            var image = frames[layer.index]
            if let next = layer.next {
                image = image.applyingFilter("CIDissolveTransition",
                                             parameters: [kCIInputTargetImageKey: frames[next], kCIInputTimeKey: layer.mix])
            }
            context.render(image, to: buffer, bounds: CGRect(origin: .zero, size: size), colorSpace: colorSpace)
            guard adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: fps)) else {
                throw BuildError.writer(writer.error?.localizedDescription ?? "append")
            }
            if frame % 15 == 0 || frame == timing.totalFrames - 1 {
                progress(Double(frame + 1) / Double(timing.totalFrames))
            }
        }
        video.markAsFinished()
        while silence.written < silence.total {
            try silence.feed(audio, upTo: timing.duration)
            if silence.written < silence.total { try await Task.sleep(nanoseconds: 2_000_000) }
        }
        audio.markAsFinished()
        writer.endSession(atSourceTime: CMTime(value: CMTimeValue(timing.totalFrames), timescale: fps))
        await writer.finishWriting()
        guard writer.status == .completed else { throw BuildError.writer(writer.error?.localizedDescription ?? "finish") }
        return output
    }

    /// Silent mono PCM for the whole duration, so audio edits (volume, fade, soundtrack mix) apply.
    private struct Silence {
        static let rate = 44_100
        let total: Int
        let format: CMAudioFormatDescription
        var written = 0

        init(total: Int) throws {
            self.total = total
            var asbd = AudioStreamBasicDescription(
                mSampleRate: Double(Self.rate), mFormatID: kAudioFormatLinearPCM,
                mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
                mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2,
                mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)
            var format: CMAudioFormatDescription?
            CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil,
                                           magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &format)
            guard let format else { throw BuildError.writer("audio format") }
            self.format = format
        }

        /// Appends silence up to `seconds` while the input accepts it.
        mutating func feed(_ input: AVAssetWriterInput, upTo seconds: Double) throws {
            let target = min(total, Int(seconds * Double(Self.rate)))
            while written < target, input.isReadyForMoreMediaData {
                let count = min(Self.rate / 10, target - written)
                var block: CMBlockBuffer?
                CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: count * 2,
                                                   blockAllocator: nil, customBlockSource: nil, offsetToData: 0,
                                                   dataLength: count * 2, flags: kCMBlockBufferAssureMemoryNowFlag,
                                                   blockBufferOut: &block)
                guard let block else { throw BuildError.writer("audio block") }
                CMBlockBufferFillDataBytes(with: 0, blockBuffer: block, offsetIntoDestination: 0, dataLength: count * 2)
                var sample: CMSampleBuffer?
                CMAudioSampleBufferCreateReadyWithPacketDescriptions(
                    allocator: nil, dataBuffer: block, formatDescription: format, sampleCount: count,
                    presentationTimeStamp: CMTime(value: CMTimeValue(written), timescale: CMTimeScale(Self.rate)),
                    packetDescriptions: nil, sampleBufferOut: &sample)
                guard let sample, input.append(sample) else { throw BuildError.writer("audio append") }
                written += count
            }
        }
    }
}
