import AVFoundation
import CoreMedia
import Foundation

/// Dialogue-aware background-music ducking (Phase G, landed with the multi-track core
/// because it is just automation data on the music clip).
///
/// Analysis is fully on-device and deterministic: the dialogue source (a video clip's
/// original audio) is decoded with `AVAssetReader`, RMS energy is measured in fixed
/// 100 ms windows, windows above the threshold count as speech, and speech intervals are
/// expanded by the attack/release times and smoothed into gain points. The result is
/// stored as `AudioClip.automation` (multipliers on the clip gain) via the normal
/// command layer, so ducking is previewed by the same audio mix as export, can be
/// adjusted, and is undoable. Source files are never modified.
enum AudioDucking {
    struct DialogueSpan: Sendable {
        var url: URL
        /// Where the span sits on the project timeline, and its source window.
        var timelineStart: Double
        var sourceStart: Double
        var duration: Double
        var speed: Double = 1
    }

    static let windowSeconds = 0.1

    /// RMS per 100 ms window for an audio-bearing file's first audio track.
    static func energyWindows(url: URL, sourceStart: Double, duration: Double) async -> [Double] {
        let asset = AVURLAsset(url: url)
        guard let track = try? await asset.loadTracks(withMediaType: .audio).first,
              let reader = try? AVAssetReader(asset: asset) else { return [] }
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsFloatKey: false,
            AVNumberOfChannelsKey: 1,
            AVSampleRateKey: 16_000,
        ])
        output.alwaysCopiesSampleData = false
        reader.add(output)
        reader.timeRange = CMTimeRange(
            start: CMTime(seconds: sourceStart, preferredTimescale: 600),
            duration: CMTime(seconds: duration, preferredTimescale: 600))
        guard reader.startReading() else { return [] }
        let samplesPerWindow = Int(16_000 * windowSeconds)
        var windows: [Double] = []
        var windowSum = 0.0
        var windowCount = 0
        while reader.status == .reading, let buffer = output.copyNextSampleBuffer() {
            guard let block = CMSampleBufferGetDataBuffer(buffer) else { continue }
            let length = CMBlockBufferGetDataLength(block)
            var data = Data(count: length)
            data.withUnsafeMutableBytes { dst in
                _ = CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: dst.baseAddress!)
            }
            data.withUnsafeBytes { raw in
                let samples = raw.bindMemory(to: Int16.self)
                for sample in samples {
                    let v = Double(sample) / 32768.0
                    windowSum += v * v
                    windowCount += 1
                    if windowCount == samplesPerWindow {
                        windows.append(sqrt(windowSum / Double(windowCount)))
                        windowSum = 0
                        windowCount = 0
                    }
                }
            }
        }
        if windowCount > 0 { windows.append(sqrt(windowSum / Double(windowCount))) }
        return windows
    }

    /// Speech-active intervals (project time) across all dialogue spans.
    static func speechIntervals(spans: [DialogueSpan], threshold: Double = 0.08) async -> [(start: Double, end: Double)] {
        var intervals: [(start: Double, end: Double)] = []
        for span in spans {
            let windows = await energyWindows(url: span.url, sourceStart: span.sourceStart, duration: span.duration * span.speed)
            var runStart: Int?
            for (index, rms) in windows.enumerated() {
                let active = rms >= threshold
                if active, runStart == nil { runStart = index }
                if !active, let start = runStart {
                    intervals.append((span.timelineStart + Double(start) * windowSeconds / span.speed,
                                      span.timelineStart + Double(index) * windowSeconds / span.speed))
                    runStart = nil
                }
            }
            if let start = runStart {
                intervals.append((span.timelineStart + Double(start) * windowSeconds / span.speed,
                                  span.timelineStart + span.duration))
            }
        }
        // Merge overlaps.
        let sorted = intervals.sorted { $0.start < $1.start }
        var merged: [(start: Double, end: Double)] = []
        for interval in sorted {
            if let last = merged.last, interval.start <= last.end + 0.05 {
                merged[merged.count - 1].end = max(last.end, interval.end)
            } else {
                merged.append(interval)
            }
        }
        return merged
    }

    /// Gain automation (multipliers, clip-local times) that ducks `musicClip` under speech.
    static func automation(
        spans: [DialogueSpan],
        musicClip: AudioClip,
        musicDuration: Double,
        attenuation: Double = 0.25,
        threshold: Double = 0.08,
        attack: Double = 0.15,
        release: Double = 0.35
    ) async -> [GainPoint] {
        let speech = await speechIntervals(spans: spans, threshold: threshold)
        let clipStart = musicClip.timelineStart.seconds
        var points: [GainPoint] = []
        func add(_ projectTime: Double, _ gain: Double) {
            let local = projectTime - clipStart
            guard local >= 0, local <= musicDuration else { return }
            points.append(GainPoint(time: .seconds(local), gain: gain))
        }
        for interval in speech {
            if interval.end < clipStart || interval.start > clipStart + musicDuration { continue }
            add(interval.start - attack, 1)
            add(interval.start, attenuation)
            add(interval.end, attenuation)
            add(interval.end + release, 1)
        }
        // Deterministic order; collapse duplicate timestamps keeping the lower gain
        // (safer: at a shared instant the music should already be ducked).
        var byTime: [Int64: GainPoint] = [:]
        for point in points {
            let key = point.time.value
            if let existing = byTime[key], existing.gain <= point.gain { continue }
            byTime[key] = point
        }
        return byTime.values.sorted { $0.time.seconds < $1.time.seconds }
    }
}

/// Lightweight waveform peaks for the timeline UI. Peaks are computed once per
/// (file, bucket count) on a background actor and cached; the UI never decodes audio
/// synchronously while rendering.
actor WaveformCache {
    static let shared = WaveformCache()
    private var cache: [String: [Float]] = [:]

    func peaks(url: URL, buckets: Int = 120) async -> [Float] {
        let key = "\(url.path)#\(buckets)"
        if let cached = cache[key] { return cached }
        let values = await Self.computePeaks(url: url, buckets: buckets)
        cache[key] = values
        return values
    }

    private static func computePeaks(url: URL, buckets: Int) async -> [Float] {
        let asset = AVURLAsset(url: url)
        let duration = (try? await asset.load(.duration)).map(CMTimeGetSeconds) ?? 0
        guard duration > 0, duration.isFinite else { return [] }
        let windows = await AudioDucking.energyWindows(url: url, sourceStart: 0, duration: duration)
        guard !windows.isEmpty else { return [] }
        let perBucket = max(1, windows.count / max(1, buckets))
        var peaks: [Float] = []
        var i = 0
        while i < windows.count {
            let slice = windows[i..<min(windows.count, i + perBucket)]
            peaks.append(Float(slice.max() ?? 0))
            i += perBucket
        }
        let peak = peaks.max() ?? 1
        if peak > 0 { peaks = peaks.map { $0 / peak } }
        return peaks
    }
}
