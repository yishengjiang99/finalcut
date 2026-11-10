import AVFoundation
import Foundation

/// Offline AVAudioEngine render of stacked `audio_effect` ops (ON_DEVICE_TOOLS.md §6.7 / §9.9).
/// Units are always wired EQ → pitch → distortion → delay → reverb so tails aren't pitched.
enum GroupedAudioRenderer {
    enum RenderError: Error { case engine, readerFailed }

    private static let cache = AudioEffectCache()

    static func render(
        composition: AVComposition,
        track: AVCompositionTrack,
        effects: [AudioEffectOp],
        gain: Float
    ) async throws -> URL {
        let key = cacheKey(composition: composition, effects: effects, gain: gain)
        if let cached = await cache.url(for: key), FileManager.default.fileExists(atPath: cached.path) {
            return cached
        }
        let channels = try await AudioRenderer.channelCount(of: track)
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("grouped-audio-\(UUID().uuidString).caf")
        try await Task.detached(priority: .userInitiated) {
            try renderOffline(composition: composition, track: track, channels: channels, effects: effects, gain: gain, to: url)
        }.value
        await cache.store(url, for: key)
        return url
    }

    private static func cacheKey(composition: AVComposition, effects: [AudioEffectOp], gain: Float) -> String {
        var parts = ["g\(gain)"]
        for track in composition.tracks where track.mediaType == .audio {
            for segment in track.segments {
                let m = segment.timeMapping
                parts.append("\(segment.sourceURL?.path ?? "-")@\(m.source.start.seconds)+\(m.source.duration.seconds)")
            }
        }
        for e in effects {
            parts.append("\(e.effect):\(e.intensity):\(e.reverbPreset ?? "-"):\(e.pitchSemitones ?? .nan):\(e.delaySeconds ?? .nan):\(e.mixPercent ?? .nan):\(e.gainDb ?? .nan):\(e.frequencyHz ?? .nan)")
        }
        return parts.joined(separator: "|")
    }

    private static func renderOffline(
        composition: AVComposition,
        track: AVCompositionTrack,
        channels: Int,
        effects: [AudioEffectOp],
        gain: Float,
        to url: URL
    ) throws {
        let sampleRate = AudioRenderer.sampleRate
        var pcm = try readPCM(composition: composition, track: track, channels: channels, sampleRate: sampleRate)
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate,
                                   channels: AVAudioChannelCount(channels), interleaved: false)!
        let durationFrames = pcm.frames
        let tailFrames = AVAudioFrameCount(sampleRate * 2)

        var eqBands: [(type: AVAudioUnitEQFilterType, freq: Float, gain: Float, bandwidth: Float)] = []
        var pitchCents: Float = 0
        var distortions: [(preset: AVAudioUnitDistortionPreset, wet: Float)] = []
        var delay: (time: Double, feedback: Float, wet: Float)?
        var reverbs: [(preset: AVAudioUnitReverbPreset, wet: Float)] = []
        var gateThreshold: Float?
        var muffleCutoff: Float?
        var rumbleCutoff: Float?

        for e in effects {
            let i = e.intensity
            switch e.effect {
            case "bass_boost", "bass_cut":
                let sign: Float = e.effect == "bass_boost" ? 1 : -1
                let g = Float(e.gainDb ?? GroupedIntensity.curve(i, from: 0, mid: 6, to: 12) * Double(sign))
                eqBands.append((.lowShelf, Float(e.frequencyHz ?? 100), g, 0.5))
            case "treble_boost", "treble_cut":
                let sign: Float = e.effect == "treble_boost" ? 1 : -1
                let g = Float(e.gainDb ?? GroupedIntensity.curve(i, from: 0, mid: 6, to: 12) * Double(sign))
                eqBands.append((.highShelf, Float(e.frequencyHz ?? 5000), g, 0.5))
            case "voice_boost":
                let g = Float(e.gainDb ?? GroupedIntensity.curve(i, from: 0, mid: 5, to: 10))
                eqBands.append((.highPass, 80, 0, 0.5))
                eqBands.append((.parametric, Float(e.frequencyHz ?? 2500), g, 1))
            case "remove_rumble":
                rumbleCutoff = Float(e.frequencyHz ?? GroupedIntensity.lerp(i, 80, 95, 130, 172, 200))
            case "muffle":
                muffleCutoff = Float(e.frequencyHz ?? (8000 / (1 + 6 * i)))
            case "telephone":
                // HP 300 Hz + LP 3400 Hz, mixed with the original (ON_DEVICE_TOOLS.md §9.9).
                // Applied on PCM so it does not dilute later wet effects (reverb, echo, ...).
                let mix = Self.telephoneMixAmount(intensity: i, mixPercent: e.mixPercent)
                if mix > 0 {
                    pcm = try applyTelephone(pcm, mix: mix, format: format)
                }
            case "reverb":
                let wet = Float(e.mixPercent ?? GroupedIntensity.lerp(i, 0, 30, 45, 63, 75))
                reverbs.append((reverbPreset(e.reverbPreset), wet))
            case "echo":
                let feedback = Float(GroupedIntensity.lerp(i, 0, 15, 30, 48, 60))
                let wet = Float(e.mixPercent ?? GroupedIntensity.lerp(i, 0, 30, 40, 52, 60))
                delay = (e.delaySeconds ?? 0.35, feedback, wet)
            case "pitch_up", "pitch_down":
                pitchCents += Float(Self.signedPitchSemitones(effect: e.effect, intensity: i, pitchSemitones: e.pitchSemitones) * 100)
            case "robot":
                distortions.append((.speechAlienChatter, Float((e.mixPercent ?? GroupedIntensity.mixAmount(i) * 100))))
            case "radio":
                distortions.append((.speechRadioTower, Float((e.mixPercent ?? GroupedIntensity.mixAmount(i) * 100))))
            case "distortion":
                distortions.append((.multiDistortedSquared, Float((e.mixPercent ?? GroupedIntensity.lerp(i, 0, 25, 50, 80, 100)))))
            case "noise_gate":
                gateThreshold = Float(-60 + 30 * i) // -52.5 / -45 / -36 / -30
            default:
                break
            }
        }
        if let cutoff = rumbleCutoff {
            eqBands.append((.highPass, cutoff, 0, 0.7))
        }
        if let cutoff = muffleCutoff {
            eqBands.append((.lowPass, cutoff, 0, 0.7))
        }
        let input = buffer(from: pcm, format: format)
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        engine.attach(player)

        var units: [AVAudioNode] = []
        if !eqBands.isEmpty {
            let eq = AVAudioUnitEQ(numberOfBands: eqBands.count)
            for (idx, band) in eqBands.enumerated() {
                let p = eq.bands[idx]
                p.filterType = band.type
                p.frequency = band.freq
                p.gain = band.gain
                p.bandwidth = band.bandwidth
                p.bypass = false
            }
            engine.attach(eq)
            units.append(eq)
        }
        if abs(pitchCents) > 0.5 {
            let pitch = AVAudioUnitTimePitch()
            pitch.pitch = max(-2400, min(2400, pitchCents))
            pitch.rate = 1
            engine.attach(pitch)
            units.append(pitch)
        }
        for item in distortions {
            let d = AVAudioUnitDistortion()
            d.loadFactoryPreset(item.preset)
            d.wetDryMix = max(0, min(100, item.wet))
            engine.attach(d)
            units.append(d)
        }
        if let delay {
            let unit = AVAudioUnitDelay()
            unit.delayTime = delay.time
            unit.feedback = delay.feedback
            unit.lowPassCutoff = 8000
            unit.wetDryMix = delay.wet
            engine.attach(unit)
            units.append(unit)
        }
        for item in reverbs {
            let unit = AVAudioUnitReverb()
            unit.loadFactoryPreset(item.preset)
            unit.wetDryMix = max(0, min(100, item.wet))
            engine.attach(unit)
            units.append(unit)
        }

        var previous: AVAudioNode = player
        for unit in units {
            engine.connect(previous, to: unit, format: format)
            previous = unit
        }
        engine.connect(previous, to: engine.mainMixerNode, format: format)
        engine.mainMixerNode.outputVolume = 1

        try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 4096)
        try engine.start()
        player.scheduleBuffer(input, at: nil, options: [])
        // 2 s of silence so reverb/echo tails ring out.
        if let silent = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: tailFrames) {
            silent.frameLength = tailFrames
            player.scheduleBuffer(silent, at: nil, options: [])
        }
        player.play()

        let file = try AVAudioFile(forWriting: url, settings: format.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        let keepFrames = durationFrames // truncate to the video duration
        var written: AVAudioFrameCount = 0
        let fadeFrames = AVAudioFrameCount(sampleRate * 0.05)
        let work = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4096)!

        while written < keepFrames + tailFrames {
            let status = try engine.renderOffline(work.frameCapacity, to: work)
            if status != .success { break }
            let available = work.frameLength
            if available == 0 { break }
            // Drop the tail past the clip duration after a 50 ms fade.
            if written >= keepFrames { break }
            let remain = keepFrames - written
            let use = min(available, remain)
            if use < available { work.frameLength = use }
            applyGainAndGate(work, channels: channels, gain: gain, gateThreshold: gateThreshold)
            if keepFrames > fadeFrames, written + use > keepFrames - fadeFrames {
                applyEndFade(work, channels: channels, written: written, use: use, keep: keepFrames, fade: fadeFrames)
            }
            try file.write(from: work)
            written += use
            if status == .insufficientDataFromInputNode { break }
        }
        engine.stop()
    }


    /// Signed semitone shift. `pitch_down` always lowers and `pitch_up` always raises,
    /// even when an explicit `pitchSemitones` has the opposite sign.
    static func signedPitchSemitones(effect: String, intensity: Double, pitchSemitones: Double?) -> Double {
        let magnitude = abs(pitchSemitones ?? Double((12 * intensity).rounded()))
        return effect == "pitch_down" ? -magnitude : magnitude
    }

    /// Band-limited share: 50% at 0.25, 100% at the 0.5 default (`mix_percent` overrides).
    static func telephoneMixAmount(intensity: Double, mixPercent: Double?) -> Double {
        GroupedIntensity.clamp01(mixPercent.map { $0 / 100 } ?? GroupedIntensity.mixAmount(intensity))
    }

    /// Butterworth-style high-pass 300 Hz + low-pass 3400 Hz, mixed with the dry signal.
    private static func applyTelephone(_ pcm: PCM, mix: Double, format: AVAudioFormat) throws -> PCM {
        if mix <= 0 { return pcm }
        let wet = try renderThroughEQ(pcm, format: format, bands: [
            (.highPass, 300, 0, 0.7),
            (.lowPass, 3400, 0, 0.7),
        ])
        if mix >= 1 { return wet }
        let k = Float(mix)
        var channels = pcm.channels
        for c in 0..<min(channels.count, wet.channels.count) {
            let n = min(channels[c].count, wet.channels[c].count)
            for i in 0..<n {
                channels[c][i] = channels[c][i] * (1 - k) + wet.channels[c][i] * k
            }
        }
        return PCM(frames: pcm.frames, channels: channels)
    }

    private static func renderThroughEQ(
        _ pcm: PCM,
        format: AVAudioFormat,
        bands: [(type: AVAudioUnitEQFilterType, freq: Float, gain: Float, bandwidth: Float)]
    ) throws -> PCM {
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        let eq = AVAudioUnitEQ(numberOfBands: bands.count)
        for (idx, band) in bands.enumerated() {
            let p = eq.bands[idx]
            p.filterType = band.type
            p.frequency = band.freq
            p.gain = band.gain
            p.bandwidth = band.bandwidth
            p.bypass = false
        }
        engine.attach(player)
        engine.attach(eq)
        engine.connect(player, to: eq, format: format)
        engine.connect(eq, to: engine.mainMixerNode, format: format)
        try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 4096)
        try engine.start()
        let input = buffer(from: pcm, format: format)
        player.scheduleBuffer(input, at: nil, options: [])
        player.play()
        var out = Array(repeating: [Float](), count: Int(format.channelCount))
        let work = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4096)!
        var collected: AVAudioFrameCount = 0
        while collected < pcm.frames {
            let status = try engine.renderOffline(work.frameCapacity, to: work)
            if status != .success && work.frameLength == 0 { break }
            let n = Int(work.frameLength)
            if n == 0 { break }
            if let data = work.floatChannelData {
                for c in 0..<out.count {
                    out[c].append(contentsOf: UnsafeBufferPointer(start: data[c], count: n))
                }
            }
            collected += work.frameLength
            if status == .insufficientDataFromInputNode { break }
        }
        engine.stop()
        let frames = out.first.map { AVAudioFrameCount($0.count) } ?? 0
        return PCM(frames: frames, channels: out)
    }

    private static func applyGainAndGate(_ buffer: AVAudioPCMBuffer, channels: Int, gain: Float, gateThreshold: Float?) {
        guard let data = buffer.floatChannelData else { return }
        let frames = Int(buffer.frameLength)
        if let threshold = gateThreshold {
            // Simple envelope follower + gate (attack 5 ms, hold 50 ms, release 100 ms, floor -60 dB).
            let sampleRate = Float(buffer.format.sampleRate)
            let attack = exp(-1 / (0.005 * sampleRate))
            let release = exp(-1 / (0.100 * sampleRate))
            let holdSamples = Int(0.050 * Double(sampleRate))
            let floor: Float = pow(10, -60 / 20)
            var env: Float = 0
            var held = 0
            for f in 0..<frames {
                var peak: Float = 0
                for c in 0..<channels { peak = max(peak, abs(data[c][f])) }
                if peak > env { env = peak + (env - peak) * attack; held = holdSamples }
                else if held > 0 { held -= 1 }
                else { env = peak + (env - peak) * release }
                let open = env >= pow(10, threshold / 20)
                let g = (open ? 1 : floor) * gain
                for c in 0..<channels { data[c][f] = max(-1, min(1, data[c][f] * g)) }
            }
        } else if gain != 1 {
            for c in 0..<channels {
                let dst = data[c]
                for f in 0..<frames { dst[f] = max(-1, min(1, dst[f] * gain)) }
            }
        }
    }

    private static func applyEndFade(_ buffer: AVAudioPCMBuffer, channels: Int, written: AVAudioFrameCount, use: AVAudioFrameCount, keep: AVAudioFrameCount, fade: AVAudioFrameCount) {
        guard let data = buffer.floatChannelData else { return }
        let fadeStart = keep - fade
        for i in 0..<Int(use) {
            let absFrame = Int(written) + i
            if absFrame < Int(fadeStart) { continue }
            let t = 1 - Float(absFrame - Int(fadeStart)) / Float(fade)
            let g = max(0, t)
            for c in 0..<channels { data[c][i] *= g }
        }
    }

    private static func reverbPreset(_ name: String?) -> AVAudioUnitReverbPreset {
        switch name {
        case "small_room": return .smallRoom
        case "medium_room": return .mediumRoom
        case "large_room": return .largeRoom
        case "large_hall": return .largeHall
        case "plate": return .plate
        case "medium_chamber": return .mediumChamber
        case "large_chamber": return .largeChamber
        case "cathedral": return .cathedral
        default: return .mediumHall
        }
    }

    private struct PCM {
        var frames: AVAudioFrameCount
        var channels: [[Float]]
    }

    private static func readPCM(composition: AVComposition, track: AVCompositionTrack, channels: Int, sampleRate: Double) throws -> PCM {
        _ = sampleRate
        let interleaved = try AudioRenderer.readInterleaved(composition: composition, track: track, channels: channels)
        let frames = interleaved.count / max(channels, 1)
        var chans = Array(repeating: [Float](repeating: 0, count: frames), count: channels)
        for f in 0..<frames {
            for c in 0..<channels {
                chans[c][f] = interleaved[f * channels + c]
            }
        }
        return PCM(frames: AVAudioFrameCount(frames), channels: chans)
    }

    private static func buffer(from pcm: PCM, format: AVAudioFormat) -> AVAudioPCMBuffer {
        let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: pcm.frames)!
        buf.frameLength = pcm.frames
        if let data = buf.floatChannelData {
            for c in 0..<pcm.channels.count {
                pcm.channels[c].withUnsafeBufferPointer { src in
                    data[c].update(from: src.baseAddress!, count: Int(pcm.frames))
                }
            }
        }
        return buf
    }
}

private actor AudioEffectCache {
    private var entries: [String: URL] = [:]
    func url(for key: String) -> URL? { entries[key] }
    func store(_ url: URL, for key: String) { entries[key] = url }
}
