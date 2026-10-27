import CoreMedia
import Foundation

/// The single mutation layer for timeline edits. The SwiftUI timeline, the AI tool
/// executor and tests ALL go through `ProjectCommand.apply` — there is no second editing
/// engine for manual actions. Every command is validated against a copy first; a failed
/// command leaves the project untouched (atomic), and a successful one returns the IDs it
/// affected plus the new project duration for the tool result / UI.
enum ProjectCommand: Equatable, Sendable {
    // Assets / import
    case addAsset(MediaAsset)
    case appendVideoClip(assetID: UUID, sourceStart: Double?, sourceEnd: Double?)
    case insertVideoClip(assetID: UUID, atIndex: Int, sourceStart: Double?, sourceEnd: Double?)
    case clearClipEffects(clipID: UUID?) // nil = every clip
    // Video timeline
    case reorderVideoClips(orderedIDs: [UUID])
    case splitVideoClip(clipID: UUID, atProjectTime: Double)
    case trimVideoClip(clipID: UUID, sourceStart: Double, sourceEnd: Double)
    case removeVideoClip(clipID: UUID)
    case duplicateVideoClip(clipID: UUID)
    case setVideoClipSpeed(clipID: UUID, speed: Double)
    case setVideoClipOriginalAudio(clipID: UUID, enabled: Bool, gain: Double?)
    case applyClipEffect(clipID: UUID?, effect: ClipEffect) // nil clipID = every clip
    case setVideoClipTransition(clipID: UUID, transition: TransitionSpec)
    case setVideoClipFades(clipID: UUID, fadeIn: Double?, fadeOut: Double?)
    // Audio lanes
    case createAudioTrack(name: String, kind: AudioTrackKind)
    case insertAudioClip(trackID: UUID, assetID: UUID, timelineStart: Double, sourceStart: Double?, sourceDuration: Double?, gain: Double?, loop: Bool, repeatUntil: Double?)
    case moveAudioClip(clipID: UUID, toTrackID: UUID?, timelineStart: Double)
    case trimAudioClip(clipID: UUID, sourceStart: Double, sourceDuration: Double)
    case removeAudioClip(clipID: UUID)
    case setAudioClipVolume(clipID: UUID, gain: Double)
    case setAudioClipMuted(clipID: UUID, muted: Bool)
    case setAudioTrackVolume(trackID: UUID, gain: Double)
    case setAudioTrackMuted(trackID: UUID, muted: Bool)
    case setAudioFade(clipID: UUID, isIn: Bool, duration: Double)
    case loopAudioClip(clipID: UUID, repeatUntil: Double?)
    case setAudioClipAutomation(clipID: UUID, points: [GainPoint])
    // Project
    case setCanvas(width: Int, height: Int, fit: CanvasFit?)
    case selectClip(clipID: UUID?)
}

struct ProjectCommandResult: Equatable, Sendable {
    var affectedIDs: [UUID] = []
    var createdID: UUID?
    var projectDurationSeconds: Double = 0
    var message: String = ""
}

enum ProjectCommandError: Error, Equatable {
    case invalid(String)
    var code: String {
        switch self { case .invalid(let code): return code }
    }
}

enum ProjectCommandExecutor {
    static func apply(_ command: ProjectCommand, to project: inout EditorProject) throws -> ProjectCommandResult {
        var copy = project
        let result = try applyMutating(command, to: &copy)
        try copy.validateOrThrow()
        project = copy
        var out = result
        out.projectDurationSeconds = (project.durationSeconds * 1000).rounded() / 1000
        return out
    }

    private static func bad(_ code: String) -> ProjectCommandError { .invalid(code) }

    private static func applyMutating(_ command: ProjectCommand, to p: inout EditorProject) throws -> ProjectCommandResult {
        var result = ProjectCommandResult()
        switch command {
        case .addAsset(let asset):
            if p.asset(asset.id) == nil { p.assets.append(asset) }
            result.affectedIDs = [asset.id]
            result.message = "asset added"

        case .appendVideoClip(let assetID, let sourceStart, let sourceEnd):
            guard let asset = p.asset(assetID) else { throw bad("asset_not_found") }
            guard asset.mediaType == .video else { throw bad("asset_not_video") }
            let start = sourceStart ?? 0
            let end = sourceEnd ?? asset.duration.seconds
            guard start >= 0, end > start, end <= asset.duration.seconds + 0.05 else { throw bad("invalid_source_range") }
            let clip = VideoClip(id: UUID(), assetID: assetID,
                                 sourceStart: .seconds(start), sourceEnd: .seconds(min(end, asset.duration.seconds)),
                                 originalAudioEnabled: asset.hasAudio)
            p.videoClips.append(clip)
            p.selectedClipID = clip.id
            result.affectedIDs = [clip.id]; result.createdID = clip.id
            result.message = "clip appended"

        case .insertVideoClip(let assetID, let atIndex, let sourceStart, let sourceEnd):
            guard let asset = p.asset(assetID) else { throw bad("asset_not_found") }
            guard asset.mediaType == .video else { throw bad("asset_not_video") }
            let start = sourceStart ?? 0
            let end = sourceEnd ?? asset.duration.seconds
            guard start >= 0, end > start, end <= asset.duration.seconds + 0.05 else { throw bad("invalid_source_range") }
            let clip = VideoClip(id: UUID(), assetID: assetID,
                                 sourceStart: .seconds(start), sourceEnd: .seconds(min(end, asset.duration.seconds)),
                                 originalAudioEnabled: asset.hasAudio)
            let index = min(max(0, atIndex), p.videoClips.count)
            p.videoClips.insert(clip, at: index)
            p.selectedClipID = clip.id
            result.affectedIDs = [clip.id]; result.createdID = clip.id
            result.message = "clip inserted"

        case .clearClipEffects(let clipID):
            if let clipID {
                guard let index = p.clipIndex(clipID) else { throw bad("clip_not_found") }
                p.videoClips[index].effects.removeAll()
                result.affectedIDs = [clipID]
            } else {
                for i in p.videoClips.indices { p.videoClips[i].effects.removeAll() }
                result.affectedIDs = p.videoClips.map(\.id)
            }
            result.message = "effects cleared"

        case .reorderVideoClips(let orderedIDs):
            guard orderedIDs.count == p.videoClips.count, Set(orderedIDs) == Set(p.videoClips.map(\.id)) else {
                throw bad("reorder_ids_mismatch")
            }
            let byID = Dictionary(uniqueKeysWithValues: p.videoClips.map { ($0.id, $0) })
            p.videoClips = orderedIDs.compactMap { byID[$0] }
            result.affectedIDs = orderedIDs
            result.message = "clips reordered"

        case .splitVideoClip(let clipID, let atProjectTime):
            guard let index = p.clipIndex(clipID), let entry = p.layout(for: clipID) else { throw bad("clip_not_found") }
            let clip = p.videoClips[index]
            let time = CMTime(seconds: atProjectTime, preferredTimescale: 600)
            // Must land strictly inside the clip, with a usable piece on both sides.
            let local = CMTimeSubtract(time, entry.start)
            guard local > CMTime(seconds: 0.05, preferredTimescale: 600),
                  local < CMTimeSubtract(entry.duration, CMTime(seconds: 0.05, preferredTimescale: 600)) else {
                throw bad("split_outside_clip")
            }
            let splitSource = CMTimeAdd(clip.sourceStart.cmTime, CMTimeMultiplyByFloat64(local, multiplier: clip.speed))
            var first = clip
            var second = clip
            second.id = UUID()
            first.sourceEnd = CodableTime(splitSource)
            second.sourceStart = CodableTime(splitSource)
            // Captions split with the range they fall in; the transition out belongs to the
            // second half (it is the edge that meets the next clip).
            first.captions = clip.captions.filter { $0.end <= splitSource.seconds + 0.001 }
            second.captions = clip.captions.filter { $0.start >= splitSource.seconds - 0.001 }
            second.transitionOut = clip.transitionOut
            first.transitionOut = .cut
            // Audio fades: the first half keeps the fade-in, the second the fade-out.
            second.audioFadeIn = 0
            first.audioFadeOut = 0
            p.videoClips[index] = first
            p.videoClips.insert(second, at: index + 1)
            p.selectedClipID = second.id
            result.affectedIDs = [first.id, second.id]; result.createdID = second.id
            result.message = "clip split"

        case .trimVideoClip(let clipID, let sourceStart, let sourceEnd):
            guard let index = p.clipIndex(clipID) else { throw bad("clip_not_found") }
            p.videoClips[index].sourceStart = .seconds(sourceStart)
            p.videoClips[index].sourceEnd = .seconds(sourceEnd)
            result.affectedIDs = [clipID]
            result.message = "clip trimmed"

        case .removeVideoClip(let clipID):
            guard p.clipIndex(clipID) != nil else { throw bad("clip_not_found") }
            p.videoClips.removeAll { $0.id == clipID }
            if p.selectedClipID == clipID { p.selectedClipID = p.videoClips.first?.id }
            result.affectedIDs = [clipID]
            result.message = "clip removed"

        case .duplicateVideoClip(let clipID):
            guard let index = p.clipIndex(clipID) else { throw bad("clip_not_found") }
            var copy = p.videoClips[index]
            copy.id = UUID()
            p.videoClips.insert(copy, at: index + 1)
            p.selectedClipID = copy.id
            result.affectedIDs = [copy.id]; result.createdID = copy.id
            result.message = "clip duplicated"

        case .setVideoClipSpeed(let clipID, let speed):
            guard let index = p.clipIndex(clipID) else { throw bad("clip_not_found") }
            guard (0.05...16).contains(speed) else { throw bad("speed 0.05-16") }
            p.videoClips[index].speed = speed
            result.affectedIDs = [clipID]
            result.message = "clip speed set"

        case .setVideoClipOriginalAudio(let clipID, let enabled, let gain):
            guard let index = p.clipIndex(clipID) else { throw bad("clip_not_found") }
            p.videoClips[index].originalAudioEnabled = enabled
            if let gain {
                guard (0...4).contains(gain) else { throw bad("gain 0-4") }
                p.videoClips[index].audioGain = gain
            }
            result.affectedIDs = [clipID]
            result.message = "clip original audio updated"

        case .applyClipEffect(let clipID, let effect):
            if let clipID {
                guard let index = p.clipIndex(clipID) else { throw bad("clip_not_found") }
                p.videoClips[index].effects.append(effect)
                result.affectedIDs = [clipID]
            } else {
                for i in p.videoClips.indices { p.videoClips[i].effects.append(effect) }
                result.affectedIDs = p.videoClips.map(\.id)
            }
            result.message = "effect applied"

        case .setVideoClipTransition(let clipID, let transition):
            guard let index = p.clipIndex(clipID) else { throw bad("clip_not_found") }
            guard transition.duration.cmTime >= .zero else { throw bad("transition_negative_duration") }
            p.videoClips[index].transitionOut = transition
            result.affectedIDs = [clipID]
            result.message = "transition set"

        case .setVideoClipFades(let clipID, let fadeIn, let fadeOut):
            guard let index = p.clipIndex(clipID) else { throw bad("clip_not_found") }
            if let fadeIn { guard fadeIn >= 0 else { throw bad("fade_negative") }; p.videoClips[index].audioFadeIn = fadeIn }
            if let fadeOut { guard fadeOut >= 0 else { throw bad("fade_negative") }; p.videoClips[index].audioFadeOut = fadeOut }
            result.affectedIDs = [clipID]
            result.message = "clip fades set"

        case .createAudioTrack(let name, let kind):
            let track = AudioTrack(id: UUID(), name: name.isEmpty ? "Audio" : name, kind: kind)
            p.audioTracks.append(track)
            result.affectedIDs = [track.id]; result.createdID = track.id
            result.message = "audio track created"

        case .insertAudioClip(let trackID, let assetID, let timelineStart, let sourceStart, let sourceDuration, let gain, let loop, let repeatUntil):
            guard let trackIndex = p.audioTracks.firstIndex(where: { $0.id == trackID }) else { throw bad("audio_track_not_found") }
            guard let asset = p.asset(assetID) else { throw bad("asset_not_found") }
            guard asset.mediaType == .audio || asset.mediaType == .video else { throw bad("asset_has_no_audio") }
            let start = sourceStart ?? 0
            let length = sourceDuration ?? min(asset.duration.seconds - start, max(0, asset.duration.seconds))
            guard timelineStart >= 0, start >= 0, length > 0, start + length <= asset.duration.seconds + 0.05 else { throw bad("invalid_source_range") }
            if let gain, !(0...4).contains(gain) { throw bad("gain 0-4") }
            let clip = AudioClip(id: UUID(), assetID: assetID,
                                 sourceStart: .seconds(start), sourceDuration: .seconds(min(length, asset.duration.seconds)),
                                 timelineStart: .seconds(timelineStart), gain: gain ?? 1,
                                 loop: loop, repeatUntil: repeatUntil.map { CodableTime.seconds($0) })
            p.audioTracks[trackIndex].clips.append(clip)
            p.selectedAudioClipID = clip.id
            result.affectedIDs = [clip.id]; result.createdID = clip.id
            result.message = "audio clip inserted"

        case .moveAudioClip(let clipID, let toTrackID, let timelineStart):
            guard timelineStart >= 0 else { throw bad("negative_start") }
            guard let found = p.audioClip(clipID) else { throw bad("audio_clip_not_found") }
            let destinationID = toTrackID ?? found.track.id
            guard p.audioTrack(destinationID) != nil else { throw bad("audio_track_not_found") }
            for t in p.audioTracks.indices { p.audioTracks[t].clips.removeAll { $0.id == clipID } }
            var clip = found.clip
            clip.timelineStart = .seconds(timelineStart)
            if let dest = p.audioTracks.firstIndex(where: { $0.id == destinationID }) {
                p.audioTracks[dest].clips.append(clip)
            }
            result.affectedIDs = [clipID]
            result.message = "audio clip moved"

        case .trimAudioClip(let clipID, let sourceStart, let sourceDuration):
            guard let (track, _) = p.audioClip(clipID),
                  let t = p.audioTracks.firstIndex(where: { $0.id == track.id }),
                  let c = p.audioTracks[t].clips.firstIndex(where: { $0.id == clipID }) else { throw bad("audio_clip_not_found") }
            p.audioTracks[t].clips[c].sourceStart = .seconds(sourceStart)
            p.audioTracks[t].clips[c].sourceDuration = .seconds(sourceDuration)
            result.affectedIDs = [clipID]
            result.message = "audio clip trimmed"

        case .removeAudioClip(let clipID):
            guard p.audioClip(clipID) != nil else { throw bad("audio_clip_not_found") }
            for t in p.audioTracks.indices { p.audioTracks[t].clips.removeAll { $0.id == clipID } }
            if p.selectedAudioClipID == clipID { p.selectedAudioClipID = nil }
            result.affectedIDs = [clipID]
            result.message = "audio clip removed"

        case .setAudioClipVolume(let clipID, let gain):
            guard (0...4).contains(gain) else { throw bad("gain 0-4") }
            try mutateAudioClip(&p, clipID) { $0.gain = gain }
            result.affectedIDs = [clipID]; result.message = "audio clip volume set"

        case .setAudioClipMuted(let clipID, let muted):
            try mutateAudioClip(&p, clipID) { $0.muted = muted }
            result.affectedIDs = [clipID]; result.message = "audio clip mute set"

        case .setAudioTrackVolume(let trackID, let gain):
            guard (0...4).contains(gain) else { throw bad("gain 0-4") }
            guard let t = p.audioTracks.firstIndex(where: { $0.id == trackID }) else { throw bad("audio_track_not_found") }
            p.audioTracks[t].gain = gain
            result.affectedIDs = [trackID]; result.message = "track volume set"

        case .setAudioTrackMuted(let trackID, let muted):
            guard let t = p.audioTracks.firstIndex(where: { $0.id == trackID }) else { throw bad("audio_track_not_found") }
            p.audioTracks[t].muted = muted
            result.affectedIDs = [trackID]; result.message = "track mute set"

        case .setAudioFade(let clipID, let isIn, let duration):
            guard duration >= 0 else { throw bad("fade_negative") }
            if p.clip(clipID) != nil {
                try ProjectCommandExecutor.applyMutating(.setVideoClipFades(clipID: clipID, fadeIn: isIn ? duration : nil, fadeOut: isIn ? nil : duration), to: &p)
            } else {
                try mutateAudioClip(&p, clipID) { if isIn { $0.fadeIn = duration } else { $0.fadeOut = duration } }
            }
            result.affectedIDs = [clipID]; result.message = "fade set"

        case .loopAudioClip(let clipID, let repeatUntil):
            try mutateAudioClip(&p, clipID) {
                $0.loop = true
                if let repeatUntil { $0.repeatUntil = .seconds(repeatUntil) }
            }
            result.affectedIDs = [clipID]; result.message = "audio clip looping"

        case .setAudioClipAutomation(let clipID, let points):
            try mutateAudioClip(&p, clipID) { $0.automation = points.sorted { $0.time.seconds < $1.time.seconds } }
            result.affectedIDs = [clipID]; result.message = "automation set"

        case .setCanvas(let width, let height, let fit):
            guard width >= 2, height >= 2, width <= 8192, height <= 8192 else { throw bad("canvas_size") }
            p.canvas.width = width; p.canvas.height = height
            if let fit { p.canvas.fit = fit }
            result.message = "canvas set"

        case .selectClip(let clipID):
            if let clipID {
                if p.clip(clipID) != nil {
                    p.selectedClipID = clipID
                } else if p.audioClip(clipID) != nil {
                    p.selectedAudioClipID = clipID
                } else {
                    throw bad("clip_not_found")
                }
            } else {
                p.selectedClipID = nil
                p.selectedAudioClipID = nil
            }
            result.affectedIDs = clipID.map { [$0] } ?? []
            result.message = "selection changed"
        }
        return result
    }

    private static func mutateAudioClip(_ p: inout EditorProject, _ clipID: UUID, _ mutate: (inout AudioClip) -> Void) throws {
        for t in p.audioTracks.indices {
            if let c = p.audioTracks[t].clips.firstIndex(where: { $0.id == clipID }) {
                mutate(&p.audioTracks[t].clips[c])
                return
            }
        }
        throw bad("audio_clip_not_found")
    }
}
