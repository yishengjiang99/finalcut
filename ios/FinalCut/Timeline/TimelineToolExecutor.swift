import Foundation

/// AI timeline tools (Phase E). The server offers these only to builds ≥
/// `TIMELINE_MIN_BUILD`; here they are parsed, validated and dispatched to the SAME
/// `ProjectCommand` layer the timeline UI uses. IDs are resolved against the current
/// project — never positions or file names — and an unknown ID fails with an error the
/// model can recover from (call get_timeline and retry), leaving the project untouched.
///
/// Tool results carry `output.project` (fresh summary), `output.project_duration`,
/// and the affected/created IDs so the model can chain calls (split → trim the new
/// clip, create lane → insert into it) without guessing.
enum TimelineTools {
    static let names: Set<String> = [
        "list_project_assets", "get_timeline", "get_clip_info", "get_project_duration",
        "append_video_clips", "reorder_video_clips", "split_video_clip", "trim_video_clip",
        "remove_video_clip", "duplicate_video_clip", "set_video_clip_speed",
        "apply_clip_effect", "set_video_clip_transition", "create_audio_lane",
        "insert_audio_clip", "move_audio_clip", "trim_audio_clip", "remove_audio_clip",
        "set_audio_clip_volume", "set_audio_track_volume", "mute_audio_track",
        "set_audio_fade", "loop_audio_clip", "set_audio_ducking", "set_project_canvas",
    ]
}

extension EditorViewModel {
    private func argID(_ args: [String: JSONValue], _ key: String) -> UUID? {
        args[key]?.stringValue.flatMap(UUID.init(uuidString:))
    }
    private func argIDs(_ args: [String: JSONValue], _ key: String) -> [UUID]? {
        args[key]?.arrayValue?.compactMap { $0.stringValue.flatMap(UUID.init(uuidString:)) }
    }
    private func argNum(_ args: [String: JSONValue], _ key: String) -> Double? {
        args[key]?.numberValue
    }

    private func timelineFailure(_ code: String) -> ClientToolResult {
        .failure(code, on: .device)
    }

    private func timelineSuccess(_ project: EditorProject, result: ProjectCommandResult?, extra: [String: JSONValue] = [:]) -> ClientToolResult {
        var output: [String: JSONValue] = [
            "project_duration": .number((project.durationSeconds * 1000).rounded() / 1000),
            "project": (try? Self.jsonValue(of: project.summary())) ?? .object([:]),
        ]
        if let result {
            if !result.affectedIDs.isEmpty {
                output["affected_ids"] = .array(result.affectedIDs.map { .string($0.uuidString) })
            }
            if let created = result.createdID { output["created_id"] = .string(created.uuidString) }
            if !result.message.isEmpty { output["message"] = .string(result.message) }
        }
        for (k, v) in extra { output[k] = v }
        return .success(on: .device, output: output)
    }

    private static func jsonValue<T: Encodable>(of value: T) throws -> JSONValue {
        let data = try JSONEncoder().encode(value)
        guard let parsed = JSONValue.parse(String(decoding: data, as: UTF8.self)) else {
            throw ProjectCommandError.invalid("summary_encode_failed")
        }
        return parsed
    }

    /// Executes one timeline tool call. Assumes the caller checked
    /// `TimelineTools.names.contains(call.name)`.
    func executeTimelineTool(_ call: ClientToolCall) async -> ClientToolResult {
        let tool = call.name
        let args = call.arguments
        guard await ensureTimelineProject() != nil, let project0 = timelineProject else {
            return timelineFailure("no_media")
        }

        // Queries (read-only; never create undo entries).
        switch tool {
        case "get_timeline", "list_project_assets":
            return timelineSuccess(project0, result: nil)
        case "get_project_duration":
            return timelineSuccess(project0, result: nil,
                                   extra: ["duration": .number((project0.durationSeconds * 1000).rounded() / 1000)])
        case "get_clip_info":
            guard let id = argID(args, "clip_id"), let clip = project0.clip(id) else {
                return timelineFailure("clip_not_found: call get_timeline for current clip IDs")
            }
            let layoutEntry = project0.layout(for: id)
            return timelineSuccess(project0, result: nil, extra: [
                "clip": .object([
                    "id": .string(clip.id.uuidString),
                    "asset_id": .string(clip.assetID.uuidString),
                    "timeline_start": .number(layoutEntry?.start.seconds ?? 0),
                    "source_start": .number(clip.sourceStart.seconds),
                    "source_end": .number(clip.sourceEnd.seconds),
                    "speed": .number(clip.speed),
                    "original_audio_enabled": .bool(clip.originalAudioEnabled),
                    "audio_gain": .number(clip.audioGain),
                    "transition_out": .string(clip.transitionOut.kind.rawValue),
                ]),
            ])
        default:
            break
        }

        // Mutations → ProjectCommand.
        let command: ProjectCommand
        switch tool {
        case "append_video_clips":
            guard let ids = argIDs(args, "asset_ids"), !ids.isEmpty else { return timelineFailure("asset_ids required") }
            // Multi-append runs as a sequence of single commands (each validated).
            var last: ProjectCommandResult?
            for id in ids {
                guard let r = await performTimelineCommand(.appendVideoClip(assetID: id, sourceStart: nil, sourceEnd: nil)) else {
                    return timelineFailure(lastError ?? "append_failed for asset \(id.uuidString): unknown asset or not a video")
                }
                last = r
            }
            guard let project = timelineProject else { return timelineFailure("no_media") }
            return timelineSuccess(project, result: last)
        case "reorder_video_clips":
            guard let ids = argIDs(args, "clip_ids") else { return timelineFailure("clip_ids required") }
            command = .reorderVideoClips(orderedIDs: ids)
        case "split_video_clip":
            guard let id = argID(args, "clip_id"), let at = argNum(args, "at") else { return timelineFailure("clip_id and at required") }
            command = .splitVideoClip(clipID: id, atProjectTime: at)
        case "trim_video_clip":
            guard let id = argID(args, "clip_id"), let start = argNum(args, "start"), let end = argNum(args, "end") else {
                return timelineFailure("clip_id, start and end required")
            }
            command = .trimVideoClip(clipID: id, sourceStart: start, sourceEnd: end)
        case "remove_video_clip":
            guard let id = argID(args, "clip_id") else { return timelineFailure("clip_id required") }
            command = .removeVideoClip(clipID: id)
        case "duplicate_video_clip":
            guard let id = argID(args, "clip_id") else { return timelineFailure("clip_id required") }
            command = .duplicateVideoClip(clipID: id)
        case "set_video_clip_speed":
            guard let id = argID(args, "clip_id"), let speed = argNum(args, "speed") else { return timelineFailure("clip_id and speed required") }
            command = .setVideoClipSpeed(clipID: id, speed: speed)
        case "apply_clip_effect":
            guard let effect = clipEffect(from: args) else { return timelineFailure("unsupported effect kind or missing value") }
            command = .applyClipEffect(clipID: argID(args, "clip_id"), effect: effect)
        case "set_video_clip_transition":
            guard let id = argID(args, "clip_id"), let type = args["type"]?.stringValue else { return timelineFailure("clip_id and type required") }
            let kind: TransitionKind
            switch type {
            case "cross_dissolve": kind = .crossDissolve
            case "fade_through_black": kind = .fadeThroughBlack
            default: kind = .cut
            }
            command = .setVideoClipTransition(clipID: id, transition: TransitionSpec(kind: kind, duration: .seconds(argNum(args, "duration") ?? 0.5)))
        case "create_audio_lane":
            let kind: AudioTrackKind = switch args["kind"]?.stringValue {
            case "voiceover": .voiceover
            case "effects": .effects
            case "other": .other
            default: .music
            }
            command = .createAudioTrack(name: args["name"]?.stringValue ?? "Audio", kind: kind)
        case "insert_audio_clip":
            guard let track = argID(args, "track_id"), let asset = argID(args, "asset_id"),
                  let start = argNum(args, "timeline_start") else { return timelineFailure("track_id, asset_id and timeline_start required") }
            command = .insertAudioClip(trackID: track, assetID: asset, timelineStart: start,
                                       sourceStart: argNum(args, "source_start"), sourceDuration: argNum(args, "source_duration"),
                                       gain: argNum(args, "volume"), loop: args["loop"]?.boolValue ?? false,
                                       repeatUntil: argNum(args, "repeat_until"))
        case "move_audio_clip":
            guard let id = argID(args, "clip_id"), let start = argNum(args, "timeline_start") else { return timelineFailure("clip_id and timeline_start required") }
            command = .moveAudioClip(clipID: id, toTrackID: argID(args, "track_id"), timelineStart: start)
        case "trim_audio_clip":
            guard let id = argID(args, "clip_id"), let start = argNum(args, "source_start"),
                  let length = argNum(args, "source_duration") else { return timelineFailure("clip_id, source_start and source_duration required") }
            command = .trimAudioClip(clipID: id, sourceStart: start, sourceDuration: length)
        case "remove_audio_clip":
            guard let id = argID(args, "clip_id") else { return timelineFailure("clip_id required") }
            command = .removeAudioClip(clipID: id)
        case "set_audio_clip_volume":
            guard let id = argID(args, "clip_id"), let volume = argNum(args, "volume") else { return timelineFailure("clip_id and volume required") }
            command = .setAudioClipVolume(clipID: id, gain: volume)
        case "set_audio_track_volume":
            guard let id = argID(args, "track_id"), let volume = argNum(args, "volume") else { return timelineFailure("track_id and volume required") }
            command = .setAudioTrackVolume(trackID: id, gain: volume)
        case "mute_audio_track":
            let muted = args["muted"]?.boolValue ?? true
            if let clipID = argID(args, "clip_id") {
                command = .setVideoClipOriginalAudio(clipID: clipID, enabled: !muted, gain: nil)
            } else if let trackID = argID(args, "track_id") {
                command = .setAudioTrackMuted(trackID: trackID, muted: muted)
            } else {
                return timelineFailure("track_id or clip_id required")
            }
        case "set_audio_fade":
            guard let id = argID(args, "clip_id"), let type = args["type"]?.stringValue,
                  let duration = argNum(args, "duration") else { return timelineFailure("clip_id, type and duration required") }
            command = .setAudioFade(clipID: id, isIn: type == "in", duration: duration)
        case "loop_audio_clip":
            guard let id = argID(args, "clip_id") else { return timelineFailure("clip_id required") }
            command = .loopAudioClip(clipID: id, repeatUntil: argNum(args, "repeat_until"))
        case "set_audio_ducking":
            guard let id = argID(args, "clip_id") else { return timelineFailure("clip_id required") }
            return await executeDucking(clipID: id, attenuation: argNum(args, "attenuation") ?? 0.25, project: project0)
        case "set_project_canvas":
            guard let width = argNum(args, "width"), let height = argNum(args, "height") else { return timelineFailure("width and height required") }
            let fit: CanvasFit? = switch args["fit"]?.stringValue {
            case "aspect_fill": .aspectFill
            case "aspect_fit": .aspectFit
            default: nil
            }
            command = .setCanvas(width: Int(width), height: Int(height), fit: fit)
        default:
            return timelineFailure("unsupported_on_device")
        }

        guard let result = await performTimelineCommand(command) else {
            return timelineFailure(lastError ?? "invalid_arguments")
        }
        guard let project = timelineProject else { return timelineFailure("no_media") }
        return timelineSuccess(project, result: result)
    }

    private func clipEffect(from args: [String: JSONValue]) -> ClipEffect? {
        let value = args["value"]?.numberValue
        switch args["kind"]?.stringValue {
        case "brightness": return value.map { .colorControls(brightness: $0, contrast: 1, saturation: 1) }
        case "contrast": return value.map { .colorControls(brightness: 0, contrast: $0, saturation: 1) }
        case "saturation": return value.map { .colorControls(brightness: 0, contrast: 1, saturation: $0) }
        case "hue": return value.map { .hue(degrees: $0) }
        case "color_filter":
            guard let filter = args["filter"]?.stringValue else { return nil }
            return .colorFilter(filter: filter, intensity: args["intensity"]?.numberValue ?? 1)
        case "flip_horizontal": return .flipHorizontal
        case "flip_vertical": return .flipVertical
        default: return nil
        }
    }

    /// Ducking: analyse every video clip's original audio (speech spans), then store
    /// the automation on the music clip as one undoable command.
    private func executeDucking(clipID: UUID, attenuation: Double, project: EditorProject) async -> ClientToolResult {
        guard let found = project.audioClip(clipID) else { return timelineFailure("audio clip_not_found") }
        var spans: [AudioDucking.DialogueSpan] = []
        for entry in project.layout {
            guard let clip = project.clip(entry.clipID), clip.originalAudioEnabled,
                  let asset = project.asset(clip.assetID), asset.hasAudio else { continue }
            spans.append(.init(
                url: NativeComposer.resolveAssetURL(asset, in: project),
                timelineStart: entry.start.seconds,
                sourceStart: clip.sourceStart.seconds,
                duration: clip.sourceDuration.seconds,
                speed: clip.speed))
        }
        guard !spans.isEmpty else { return timelineFailure("no dialogue audio to analyse") }
        let musicDuration = found.clip.outputDuration(projectEnd: project.duration)
        let points = await AudioDucking.automation(
            spans: spans, musicClip: found.clip, musicDuration: musicDuration.seconds,
            attenuation: min(1, max(0, attenuation)))
        guard let result = await performTimelineCommand(.setAudioClipAutomation(clipID: clipID, points: points)) else {
            return timelineFailure(lastError ?? "ducking_failed")
        }
        guard let updated = timelineProject else { return timelineFailure("no_media") }
        return timelineSuccess(updated, result: result, extra: ["automation_points": .number(Double(points.count))])
    }

    /// The fetched YouTube soundtrack, placed into the timeline project as a normal
    /// audio clip on a "Soundtrack" lane (called from the soundtrack flow when a
    /// project is active — the legacy `.soundtrack` op is not used there).
    func insertSoundtrackIntoTimeline(file: URL, startOffset: Double, originalVolume: Double) async -> Bool {
        guard let project = timelineProject else { return false }
        let assetID = UUID()
        guard let relative = try? ProjectStore.copyIntoProject(source: file, projectID: project.id, assetID: assetID),
              let asset = try? await MediaProbe.probe(
                url: ProjectStore.projectDirectory(project.id).appendingPathComponent(relative),
                relativePath: relative, id: assetID, name: file.lastPathComponent)
        else { return false }
        _ = await performTimelineCommand(.addAsset(asset))
        var trackID = timelineProject?.audioTracks.first(where: { $0.name == "Soundtrack" })?.id
        if trackID == nil {
            trackID = await performTimelineCommand(.createAudioTrack(name: "Soundtrack", kind: .music))?.createdID
        }
        guard let trackID else { return false }
        let length = max(1, min(asset.duration.seconds - startOffset, timelineProject?.durationSeconds ?? asset.duration.seconds))
        guard await performTimelineCommand(.insertAudioClip(
            trackID: trackID, assetID: assetID, timelineStart: 0,
            sourceStart: startOffset, sourceDuration: length, gain: 1, loop: false, repeatUntil: nil)) != nil else { return false }
        // Original-audio scaling, per clip (0 removes the original entirely).
        if let updated = timelineProject {
            for clip in updated.videoClips where clip.originalAudioEnabled || originalVolume <= 0 {
                _ = await performTimelineCommand(.setVideoClipOriginalAudio(
                    clipID: clip.id,
                    enabled: originalVolume > 0,
                    gain: originalVolume > 0 ? clip.audioGain * originalVolume : nil))
            }
        }
        return true
    }

    /// Legacy single-clip tools, translated onto a timeline project. Returns nil when
    /// the tool has no project translation (the caller falls through to the legacy
    /// path). Frame/colour tools target the SELECTED clip (or the whole project when
    /// the tool is phrased globally — resize becomes the canvas, volume targets the
    /// selected clip's original audio). Trim/speed translate only for a ONE-clip
    /// project, where their timeline-seconds semantics are unambiguous; on a
    /// multi-clip project the model is told to use the clip tools instead.
    func executeLegacyToolOnProject(_ call: ClientToolCall) async -> ClientToolResult? {
        guard let project = timelineProject,
              project.videoClips.count > 1 || !project.audioTracks.isEmpty else { return nil }
        let args = call.arguments
        let selected = project.selectedClipID.flatMap { project.clip($0) } ?? project.videoClips.first
        func done(_ command: ProjectCommand) async -> ClientToolResult {
            guard let result = await performTimelineCommand(command) else {
                return timelineFailure(lastError ?? "invalid_arguments")
            }
            guard let updated = timelineProject else { return timelineFailure("no_media") }
            return timelineSuccess(updated, result: result)
        }
        switch call.name {
        case "crop_video", "rotate_video", "flip_video_horizontal", "flip_video_vertical",
             "adjust_brightness", "adjust_contrast", "adjust_saturation", "adjust_hue",
             "apply_color_filter", "add_text":
            // Reuse the strict legacy parser for argument validation, then map the op
            // onto the selected clip's effect chain.
            switch NativeToolParser.plan(tool: call.name, arguments: args, canvas: projectCanvasForParser(project)) {
            case .success(.apply(let op)):
                let effect: ClipEffect?
                switch op {
                case .crop(let x, let y, let w, let h): effect = .crop(x: x, y: y, width: w, height: h)
                case .rotate(let d): effect = .rotate(degrees: d)
                case .flipHorizontal: effect = .flipHorizontal
                case .flipVertical: effect = .flipVertical
                case .colorControls(let b, let c, let s): effect = .colorControls(brightness: b, contrast: c, saturation: s)
                case .hue(let d): effect = .hue(degrees: d)
                case .colorFilter(let f, let i): effect = .colorFilter(filter: f, intensity: i)
                case .text(let text, let x, let y, let size, _): effect = .text(text: text, x: x, y: y, fontSize: size, color: "white")
                default: effect = nil
                }
                guard let target = selected, let effect else { return nil }
                return await done(.applyClipEffect(clipID: target.id, effect: effect))
            default:
                return nil
            }
        case "resize_video":
            guard let width = args["width"]?.numberValue, let height = args["height"]?.numberValue else { return nil }
            return await done(.setCanvas(width: Int(width), height: Int(height), fit: nil))
        case "trim_video":
            guard project.videoClips.count == 1, let clip = selected,
                  let start = args["start"]?.numberValue, let end = args["end"]?.numberValue else {
                return timelineFailure("ambiguous_on_timeline: use trim_video_clip with a clip_id")
            }
            return await done(.trimVideoClip(clipID: clip.id, sourceStart: start, sourceEnd: end))
        case "adjust_speed":
            guard project.videoClips.count == 1, let clip = selected,
                  let speed = args["speed"]?.numberValue ?? args["factor"]?.numberValue else {
                return timelineFailure("ambiguous_on_timeline: use set_video_clip_speed with a clip_id")
            }
            return await done(.setVideoClipSpeed(clipID: clip.id, speed: speed))
        case "adjust_audio_volume":
            guard let clip = selected, let volume = args["volume"]?.numberValue else { return nil }
            return await done(.setVideoClipOriginalAudio(clipID: clip.id, enabled: volume > 0, gain: volume))
        case "audio_fade":
            guard let clip = selected,
                  let fadeIn = args["fade_in"]?.numberValue, let fadeOut = args["fade_out"]?.numberValue else { return nil }
            return await done(.setVideoClipFades(clipID: clip.id, fadeIn: fadeIn, fadeOut: fadeOut))
        default:
            return nil
        }
    }

    private func projectCanvasForParser(_ project: EditorProject) -> NativeCanvas {
        let first = project.videoClips.first
        let asset = first.flatMap { project.asset($0.assetID) }
        return NativeCanvas(
            width: asset.map { Int($0.naturalSize.width) } ?? project.canvas.width,
            height: asset.map { Int($0.naturalSize.height) } ?? project.canvas.height,
            duration: first?.sourceDuration.seconds ?? project.durationSeconds,
            hasAudio: asset?.hasAudio ?? false,
            isPhoto: false)
    }
}
