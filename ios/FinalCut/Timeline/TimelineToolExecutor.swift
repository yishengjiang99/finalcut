import Foundation

/// AI timeline tools — the device executor for the server contract in
/// `src/server/iosTimelineTools.js` (landed on main; gated server-side by
/// TIMELINE_TOOLS_MIN_BUILD, flipped to this build when the executor ships).
///
/// Every tool maps onto the SAME `ProjectCommand` layer the timeline UI uses, is
/// validated against the live project, and answers with the contract result shape:
/// success → output { projectRevision, affectedClipIds?, createdClipId? /
/// createdTrackId?, duration, videoClipCount, audioTrackCount, project }.
/// Mutations honour `expectedRevision` (stale plan → `project_revision_conflict`
/// with the current revision, nothing applied) and `idempotencyKey` (a retried
/// call with the same key returns the original result and applies nothing twice).
/// Error codes are the contract's stable set; never paths or exception text.
enum TimelineTools {
    static let names: Set<String> = [
        "get_project_timeline", "list_project_assets", "get_clip_details",
        "get_audio_track_details", "get_project_info", "get_project_duration",
        "append_video_clips", "insert_video_clip", "reorder_video_clips",
        "split_video_clip", "trim_video_clip", "remove_video_clip",
        "duplicate_video_clip", "set_clip_speed", "set_clip_effect",
        "set_clip_original_audio", "set_clip_transition", "create_audio_track",
        "add_audio_clip", "move_audio_clip", "trim_audio_clip", "remove_audio_clip",
        "set_audio_clip_volume", "set_audio_track_volume", "mute_audio_track",
        "set_audio_clip_fade", "loop_audio_clip", "apply_audio_ducking",
        "set_project_canvas", "batch_timeline_edits",
        "select_timeline_clip", "seek_playhead",
    ]

    static let inspectionNames: Set<String> = [
        "get_project_timeline", "list_project_assets", "get_clip_details",
        "get_audio_track_details", "get_project_info", "get_project_duration",
    ]
}

extension EditorViewModel {
    // MARK: Argument helpers (landed contract: camelCase keys)

    private func argID(_ args: [String: JSONValue], _ key: String) -> UUID? {
        args[key]?.stringValue.flatMap(UUID.init(uuidString:))
    }
    private func argNum(_ args: [String: JSONValue], _ key: String) -> Double? { args[key]?.doubleValue }
    private func argInt(_ args: [String: JSONValue], _ key: String) -> Int? { args[key]?.doubleValue.map(Int.init) }

    private func failure(_ code: String, output: [String: JSONValue] = [:]) -> ClientToolResult {
        var result = ClientToolResult.failure(code, on: .device)
        if !output.isEmpty { result.output = output }
        return result
    }

    /// Contract-shaped success: revision + counts + affected/created IDs + summary.
    private func contractSuccess(_ project: EditorProject, affected: [UUID] = [], createdClip: UUID? = nil,
                                 createdTrack: UUID? = nil, extra: [String: JSONValue] = [:]) -> ClientToolResult {
        var output: [String: JSONValue] = [
            "projectRevision": .number(Double(project.revision)),
            "duration": .number((project.durationSeconds * 1000).rounded() / 1000),
            "videoClipCount": .number(Double(project.videoClips.count)),
            "audioTrackCount": .number(Double(project.audioTracks.count)),
            "project": (try? Self.jsonValue(of: project.summary())) ?? .object([:]),
        ]
        if !affected.isEmpty { output["affectedClipIds"] = .array(affected.map { .string($0.uuidString) }) }
        if let createdClip { output["createdClipId"] = .string(createdClip.uuidString) }
        if let createdTrack { output["createdTrackId"] = .string(createdTrack.uuidString) }
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

    // MARK: Entry point

    func executeTimelineTool(_ call: ClientToolCall) async -> ClientToolResult {
        let tool = call.name
        let args = call.arguments
        guard await ensureTimelineProject() != nil, let project = timelineProject else {
            return failure("no_media")
        }

        if TimelineTools.inspectionNames.contains(tool) {
            return inspection(tool, args: args, project: project)
        }
        // View state, not an edit: no revision gate, no idempotency, no undo entry.
        if tool == "seek_playhead" {
            guard let seconds = argNum(args, "seconds"), seconds.isFinite, seconds >= 0 else {
                return failure("invalid_arguments")
            }
            let playhead = seekPlayhead(to: seconds)
            return .success(on: .device, output: [
                "playheadSeconds": .number((playhead * 1000).rounded() / 1000),
                "projectRevision": .number(Double(project.revision)),
            ])
        }

        // Idempotency: a retried mutation with a known key replays its result.
        let idempotencyKey = args["idempotencyKey"]?.stringValue
        if let idempotencyKey, let cached = timelineIdempotencyCache[idempotencyKey] {
            return cached
        }
        // Revision gate: a plan made against an older project changes nothing.
        if let expected = argInt(args, "expectedRevision"), expected != project.revision {
            return failure("project_revision_conflict", output: ["currentRevision": .number(Double(project.revision))])
        }

        let result: ClientToolResult
        if tool == "batch_timeline_edits" {
            result = await executeBatch(args: args, project: project)
        } else if tool == "apply_audio_ducking" {
            result = await executeDucking(args: args, project: project)
        } else if tool == "set_audio_clip_fade" {
            // One tool, up to two commands (fade in / fade out are independent).
            if let commands = fadeCommands(args: args) {
                var affected: [UUID] = []
                var failedCode: String?
                for command in commands {
                    if let r = await performTimelineCommand(command) { affected.append(contentsOf: r.affectedIDs) }
                    else { failedCode = lastError ?? "invalid_arguments"; break }
                }
                if let failedCode { result = failure(failedCode) }
                else if let updated = timelineProject { result = contractSuccess(updated, affected: affected) }
                else { result = failure("no_media") }
            } else {
                result = failure("invalid_arguments")
            }
        } else if tool == "add_audio_clip" {
            result = await executeAddAudioClip(args: args, project: project)
        } else if tool == "append_video_clips" {
            result = await executeAppendClips(args: args, project: project)
        } else if let mapping = commandFor(tool: tool, args: args, project: project) {
            switch mapping {
            case .success(let cmd):
                if let performed = await performTimelineCommand(cmd), let updated = timelineProject {
                    let isTrackCreate = tool == "create_audio_track"
                    result = contractSuccess(updated, affected: performed.affectedIDs,
                                             createdClip: isTrackCreate ? nil : performed.createdID,
                                             createdTrack: isTrackCreate ? performed.createdID : nil)
                } else {
                    result = failure(lastError ?? "invalid_arguments")
                }
            case .failure(let code):
                result = failure(code)
            }
        } else {
            result = failure("unsupported_on_device")
        }

        if let idempotencyKey, result.ok {
            if timelineIdempotencyCache.count > 128 { timelineIdempotencyCache.removeAll() }
            timelineIdempotencyCache[idempotencyKey] = result
        }
        return result
    }

    // MARK: Inspection

    private func inspection(_ tool: String, args: [String: JSONValue], project: EditorProject) -> ClientToolResult {
        switch tool {
        case "get_project_duration":
            return contractSuccess(project)
        case "get_project_info":
            return contractSuccess(project, extra: [
                "projectId": .string(project.id.uuidString),
                "canvas": .object(["width": .number(Double(project.canvas.width)), "height": .number(Double(project.canvas.height))]),
                "selectedClipId": project.selectedClipID.map { .string($0.uuidString) } ?? .null,
            ])
        case "list_project_assets":
            let typeFilter = args["type"]?.stringValue
            let assets = project.assets.filter { typeFilter == nil || $0.mediaType.rawValue == typeFilter }
            return contractSuccess(project, extra: [
                "assets": .array(assets.map { asset in
                    .object([
                        "id": .string(asset.id.uuidString),
                        "type": .string(asset.mediaType.rawValue),
                        "label": .string(asset.name),
                        "duration": .number((asset.duration.seconds * 1000).rounded() / 1000),
                        "hasAudio": .bool(asset.hasAudio),
                    ])
                }),
            ])
        case "get_project_timeline":
            let startIndex = max(0, argInt(args, "startIndex") ?? 0)
            let maxClips = min(100, max(1, argInt(args, "maxClips") ?? 40))
            let includeAudio = args["includeAudioClips"]?.boolValue ?? true
            let layout = project.layout
            let page = Array(project.videoClips.dropFirst(startIndex).prefix(maxClips))
            return contractSuccess(project, extra: [
                "totalVideoClips": .number(Double(project.videoClips.count)),
                "truncated": .bool(startIndex + page.count < project.videoClips.count),
                "videoClips": .array(page.map { clip in
                    let entry = layout.first { $0.clipID == clip.id }
                    return .object([
                        "id": .string(clip.id.uuidString),
                        "assetId": .string(clip.assetID.uuidString),
                        "timelineStart": .number(entry?.start.seconds ?? 0),
                        "sourceStart": .number(clip.sourceStart.seconds),
                        "sourceEnd": .number(clip.sourceEnd.seconds),
                        "speed": .number(clip.speed),
                        "originalAudioEnabled": .bool(clip.originalAudioEnabled),
                        "transitionOut": .string(clip.transitionOut.kind.rawValue),
                    ])
                }),
                "audioTracks": .array(project.audioTracks.map { track in
                    var obj: [String: JSONValue] = [
                        "id": .string(track.id.uuidString),
                        "label": .string(track.name),
                        "kind": .string(track.kind.rawValue),
                        "volume": .number(track.gain),
                        "muted": .bool(track.muted),
                        "clipCount": .number(Double(track.clips.count)),
                    ]
                    if includeAudio {
                        obj["clips"] = .array(track.clips.map { clip in
                            .object([
                                "id": .string(clip.id.uuidString),
                                "assetId": .string(clip.assetID.uuidString),
                                "timelineStart": .number(clip.timelineStart.seconds),
                                "sourceStart": .number(clip.sourceStart.seconds),
                                "sourceDuration": .number(clip.sourceDuration.seconds),
                                "gain": .number(clip.gain),
                                "fadeIn": .number(clip.fadeIn),
                                "fadeOut": .number(clip.fadeOut),
                                "loop": .bool(clip.loop),
                            ])
                        })
                    }
                    return .object(obj)
                }),
            ])
        case "get_clip_details":
            guard let id = argID(args, "clipId"), let clip = project.clip(id) else { return failure("clip_not_found") }
            let entry = project.layout(for: id)
            return contractSuccess(project, extra: [
                "clip": .object([
                    "id": .string(clip.id.uuidString),
                    "assetId": .string(clip.assetID.uuidString),
                    "timelineStart": .number(entry?.start.seconds ?? 0),
                    "timelineEnd": .number(entry?.end.seconds ?? 0),
                    "sourceStart": .number(clip.sourceStart.seconds),
                    "sourceEnd": .number(clip.sourceEnd.seconds),
                    "speed": .number(clip.speed),
                    "originalAudioEnabled": .bool(clip.originalAudioEnabled),
                    "originalAudioGain": .number(clip.audioGain),
                    "effectCount": .number(Double(clip.effects.count)),
                    "transitionOut": .string(clip.transitionOut.kind.rawValue),
                    "transitionDuration": .number(clip.transitionOut.duration.seconds),
                ]),
            ])
        case "get_audio_track_details":
            guard let id = argID(args, "trackId"), let track = project.audioTrack(id) else { return failure("audio_track_not_found") }
            return contractSuccess(project, extra: [
                "track": .object([
                    "id": .string(track.id.uuidString),
                    "label": .string(track.name),
                    "kind": .string(track.kind.rawValue),
                    "volume": .number(track.gain),
                    "muted": .bool(track.muted),
                    "clips": .array(track.clips.map { clip in
                        .object([
                            "id": .string(clip.id.uuidString),
                            "assetId": .string(clip.assetID.uuidString),
                            "timelineStart": .number(clip.timelineStart.seconds),
                            "sourceStart": .number(clip.sourceStart.seconds),
                            "sourceDuration": .number(clip.sourceDuration.seconds),
                            "gain": .number(clip.gain),
                            "muted": .bool(clip.muted),
                            "fadeIn": .number(clip.fadeIn),
                            "fadeOut": .number(clip.fadeOut),
                            "loop": .bool(clip.loop),
                        ])
                    }),
                ]),
            ])
        default:
            return failure("unsupported_on_device")
        }
    }

    // MARK: Tool → command mapping (single source for direct calls AND batches)

    enum CommandMapping {
        case success(ProjectCommand)
        case failure(String)
    }

    func commandFor(tool: String, args: [String: JSONValue], project: EditorProject) -> CommandMapping? {
        switch tool {
        case "insert_video_clip":
            guard let asset = argID(args, "assetId"), let index = argInt(args, "atIndex") else { return .failure("invalid_arguments") }
            return .success(.insertVideoClip(assetID: asset, atIndex: index,
                                             sourceStart: argNum(args, "sourceStart"), sourceEnd: argNum(args, "sourceEnd")))
        case "reorder_video_clips":
            let raw = args["orderedClipIds"]?.arrayValue ?? []
            let ids = raw.compactMap { $0.stringValue.flatMap(UUID.init(uuidString:)) }
            guard ids.count == raw.count, !ids.isEmpty else { return .failure("invalid_arguments") }
            return .success(.reorderVideoClips(orderedIDs: ids))
        case "split_video_clip":
            guard let id = argID(args, "clipId"), let at = argNum(args, "atProjectTime") else { return .failure("invalid_arguments") }
            return .success(.splitVideoClip(clipID: id, atProjectTime: at))
        case "trim_video_clip":
            guard let id = argID(args, "clipId"), let start = argNum(args, "sourceStart"), let end = argNum(args, "sourceEnd") else { return .failure("invalid_arguments") }
            return .success(.trimVideoClip(clipID: id, sourceStart: start, sourceEnd: end))
        case "remove_video_clip":
            guard let id = argID(args, "clipId") else { return .failure("invalid_arguments") }
            return .success(.removeVideoClip(clipID: id))
        case "duplicate_video_clip":
            guard let id = argID(args, "clipId") else { return .failure("invalid_arguments") }
            return .success(.duplicateVideoClip(clipID: id))
        case "set_clip_speed":
            guard let id = argID(args, "clipId"), let speed = argNum(args, "speed") else { return .failure("invalid_arguments") }
            return .success(.setVideoClipSpeed(clipID: id, speed: speed))
        case "set_clip_effect":
            guard let effectObject = args["effect"]?.objectValue else { return .failure("invalid_arguments") }
            if effectObject["kind"]?.stringValue == "clear" {
                return .success(.clearClipEffects(clipID: argID(args, "clipId")))
            }
            guard let effect = clipEffect(from: effectObject) else { return .failure("invalid_arguments") }
            return .success(.applyClipEffect(clipID: argID(args, "clipId"), effect: effect))
        case "set_clip_original_audio":
            guard let id = argID(args, "clipId") else { return .failure("invalid_arguments") }
            let current = project.clip(id)
            return .success(.setVideoClipOriginalAudio(clipID: id,
                                                       enabled: args["enabled"]?.boolValue ?? current?.originalAudioEnabled ?? true,
                                                       gain: argNum(args, "gain")))
        case "set_clip_transition":
            guard let id = argID(args, "clipId"), let kindName = args["kind"]?.stringValue else { return .failure("invalid_arguments") }
            let kind: TransitionKind = switch kindName {
            case "cross_dissolve": .crossDissolve
            case "fade_through_black": .fadeThroughBlack
            default: .cut
            }
            return .success(.setVideoClipTransition(clipID: id, transition: TransitionSpec(kind: kind, duration: .seconds(argNum(args, "duration") ?? 0))))
        case "create_audio_track":
            let kind: AudioTrackKind = switch args["kind"]?.stringValue {
            case "music": .music
            case "voiceover": .voiceover
            case "effects": .effects
            default: .other
            }
            return .success(.createAudioTrack(name: args["label"]?.stringValue ?? "Audio", kind: kind))
        case "move_audio_clip":
            guard let id = argID(args, "clipId"), let start = argNum(args, "timelineStart") else { return .failure("invalid_arguments") }
            return .success(.moveAudioClip(clipID: id, toTrackID: argID(args, "toTrackId"), timelineStart: start))
        case "trim_audio_clip":
            guard let id = argID(args, "clipId"), let start = argNum(args, "sourceStart"), let length = argNum(args, "sourceDuration") else { return .failure("invalid_arguments") }
            return .success(.trimAudioClip(clipID: id, sourceStart: start, sourceDuration: length))
        case "remove_audio_clip":
            guard let id = argID(args, "clipId") else { return .failure("invalid_arguments") }
            return .success(.removeAudioClip(clipID: id))
        case "set_audio_clip_volume":
            guard let id = argID(args, "clipId"), let volume = argNum(args, "volume") else { return .failure("invalid_arguments") }
            return .success(.setAudioClipVolume(clipID: id, gain: volume))
        case "set_audio_track_volume":
            guard let id = argID(args, "trackId"), let volume = argNum(args, "volume") else { return .failure("invalid_arguments") }
            return .success(.setAudioTrackVolume(trackID: id, gain: volume))
        case "mute_audio_track":
            guard let id = argID(args, "trackId") else { return .failure("invalid_arguments") }
            return .success(.setAudioTrackMuted(trackID: id, muted: args["muted"]?.boolValue ?? true))
        case "loop_audio_clip":
            guard let id = argID(args, "clipId") else { return .failure("invalid_arguments") }
            return .success(.loopAudioClip(clipID: id, repeatUntil: argNum(args, "repeatUntil")))
        case "select_timeline_clip":
            // Omitted clipId clears both selections (the same command a deselect uses).
            guard args["clipId"] != nil else { return .success(.selectClip(clipID: nil)) }
            guard let id = argID(args, "clipId") else { return .failure("invalid_arguments") }
            return .success(.selectClip(clipID: id))
        case "set_project_canvas":
            guard let width = argNum(args, "width"), let height = argNum(args, "height") else { return .failure("invalid_arguments") }
            return .success(.setCanvas(width: Int(width), height: Int(height), fit: nil))
        default:
            return nil
        }
    }

    private func clipEffect(from effect: [String: JSONValue]) -> ClipEffect? {
        switch effect["kind"]?.stringValue {
        case "color_controls":
            return .colorControls(brightness: effect["brightness"]?.doubleValue ?? 0,
                                  contrast: effect["contrast"]?.doubleValue ?? 1,
                                  saturation: effect["saturation"]?.doubleValue ?? 1)
        case "hue":
            return (effect["degrees"]?.doubleValue).map { .hue(degrees: $0) }
        case "color_filter":
            guard let filter = effect["filter"]?.stringValue else { return nil }
            return .colorFilter(filter: filter, intensity: effect["intensity"]?.doubleValue ?? 1)
        case "crop":
            guard let x = effect["x"]?.doubleValue, let y = effect["y"]?.doubleValue,
                  let w = effect["width"]?.doubleValue, let h = effect["height"]?.doubleValue else { return nil }
            return .crop(x: Int(x), y: Int(y), width: Int(w), height: Int(h))
        case "rotate":
            return (effect["degrees"]?.doubleValue).map { .rotate(degrees: $0) }
        case "flip_horizontal": return .flipHorizontal
        case "flip_vertical": return .flipVertical
        default: return nil
        }
    }

    private func fadeCommands(args: [String: JSONValue]) -> [ProjectCommand]? {
        guard let id = argID(args, "clipId") else { return nil }
        var commands: [ProjectCommand] = []
        if let fadeIn = argNum(args, "fadeIn") { commands.append(.setAudioFade(clipID: id, isIn: true, duration: fadeIn)) }
        if let fadeOut = argNum(args, "fadeOut") { commands.append(.setAudioFade(clipID: id, isIn: false, duration: fadeOut)) }
        return commands.isEmpty ? nil : commands
    }

    // MARK: Multi-step tools

    private func executeAppendClips(args: [String: JSONValue], project: EditorProject) async -> ClientToolResult {
        guard let items = args["clips"]?.arrayValue, !items.isEmpty, items.count <= 20 else {
            return failure("invalid_arguments")
        }
        var last: ProjectCommandResult?
        for item in items {
            guard let obj = item.objectValue, let asset = obj["assetId"]?.stringValue.flatMap(UUID.init(uuidString:)) else {
                return failure("invalid_arguments")
            }
            guard let r = await performTimelineCommand(.appendVideoClip(
                assetID: asset, sourceStart: obj["sourceStart"]?.doubleValue, sourceEnd: obj["sourceEnd"]?.doubleValue)) else {
                return failure(lastError ?? "invalid_source_range")
            }
            last = r
        }
        guard let updated = timelineProject else { return failure("no_media") }
        return contractSuccess(updated, affected: last?.affectedIDs ?? [], createdClip: last?.createdID)
    }

    private func executeAddAudioClip(args: [String: JSONValue], project: EditorProject) async -> ClientToolResult {
        guard let asset = argID(args, "assetId"), let start = argNum(args, "timelineStart") else {
            return failure("invalid_arguments")
        }
        var trackID = argID(args, "trackId")
        if trackID == nil {
            trackID = timelineProject?.audioTracks.first(where: { $0.kind == .music })?.id
            if trackID == nil {
                trackID = await performTimelineCommand(.createAudioTrack(name: "Music", kind: .music))?.createdID
            }
        }
        guard let trackID else { return failure("audio_track_not_found") }
        guard let r = await performTimelineCommand(.insertAudioClip(
            trackID: trackID, assetID: asset, timelineStart: start,
            sourceStart: argNum(args, "sourceStart"), sourceDuration: argNum(args, "sourceDuration"),
            gain: argNum(args, "gain"), loop: args["loop"]?.boolValue ?? false,
            repeatUntil: argNum(args, "repeatUntil"))) else {
            return failure(lastError ?? "invalid_arguments")
        }
        guard let updated = timelineProject else { return failure("no_media") }
        return contractSuccess(updated, affected: r.affectedIDs, createdClip: r.createdID)
    }

    private func executeBatch(args: [String: JSONValue], project: EditorProject) async -> ClientToolResult {
        guard let operations = args["operations"]?.arrayValue, !operations.isEmpty, operations.count <= 20 else {
            return failure("invalid_arguments")
        }
        guard var stack = editStack else { return failure("no_media") }
        var commands: [ProjectCommand] = []
        for (index, operation) in operations.enumerated() {
            guard let obj = operation.objectValue, let type = obj["type"]?.stringValue,
                  let opArgs = obj["arguments"]?.objectValue else {
                return failure("invalid_arguments", output: ["failedOperationIndex": .number(Double(index))])
            }
            if type == "apply_audio_ducking" {
                guard let duckCommands = await duckingCommands(args: opArgs, project: project) else {
                    return failure("invalid_arguments", output: ["failedOperationIndex": .number(Double(index))])
                }
                commands.append(contentsOf: duckCommands)
                continue
            }
            if type == "set_audio_clip_fade", let expanded = fadeCommands(args: opArgs) {
                commands.append(contentsOf: expanded)
                continue
            }
            // add_audio_clip / append_video_clips can depend on IDs created inside the
            // same batch, which the contract forbids relying on — refuse them in batch.
            guard let mapping = commandFor(tool: type, args: opArgs, project: project) else {
                return failure("invalid_arguments", output: ["failedOperationIndex": .number(Double(index))])
            }
            switch mapping {
            case .success(let command): commands.append(command)
            case .failure(let code): return failure(code, output: ["failedOperationIndex": .number(Double(index))])
            }
        }
        do {
            let (results, failedIndex) = try stack.performProjectBatch(commands)
            if let failedIndex {
                return failure("invalid_arguments", output: ["failedOperationIndex": .number(Double(failedIndex))])
            }
            commitEdit(stack)
            saveTimelineProject()
            await refreshPreview()
            guard let updated = timelineProject else { return failure("no_media") }
            return contractSuccess(updated, affected: results.flatMap(\.affectedIDs))
        } catch {
            return failure("invalid_arguments")
        }
    }

    // MARK: Ducking (apply_audio_ducking)

    /// Dialogue spans: the video clips' original audio, plus clips of the tracks in
    /// againstTrackIds (voiceover tracks when omitted).
    private func dialogueSpans(args: [String: JSONValue], project: EditorProject) -> [AudioDucking.DialogueSpan] {
        var spans: [AudioDucking.DialogueSpan] = []
        for entry in project.layout {
            guard let clip = project.clip(entry.clipID), clip.originalAudioEnabled,
                  let asset = project.asset(clip.assetID), asset.hasAudio else { continue }
            spans.append(.init(url: NativeComposer.resolveAssetURL(asset, in: project),
                               timelineStart: entry.start.seconds,
                               sourceStart: clip.sourceStart.seconds,
                               duration: clip.sourceDuration.seconds,
                               speed: clip.speed))
        }
        let against = args["againstTrackIds"]?.arrayValue?.compactMap { $0.stringValue.flatMap(UUID.init(uuidString:)) }
        let dialogueTracks = project.audioTracks.filter { track in
            against.map { $0.contains(track.id) } ?? (track.kind == .voiceover)
        }
        for track in dialogueTracks {
            for clip in track.clips {
                guard let asset = project.asset(clip.assetID) else { continue }
                spans.append(.init(url: NativeComposer.resolveAssetURL(asset, in: project),
                                   timelineStart: clip.timelineStart.seconds,
                                   sourceStart: clip.sourceStart.seconds,
                                   duration: clip.sourceDuration.seconds,
                                   speed: 1))
            }
        }
        return spans
    }

    /// Automation commands for every clip on the target track (amount = fraction to
    /// lower BY, per the contract; the analyzer works with the remaining level).
    private func duckingCommands(args: [String: JSONValue], project: EditorProject) async -> [ProjectCommand]? {
        guard let trackID = argID(args, "trackId"), let track = project.audioTrack(trackID), !track.clips.isEmpty else { return nil }
        let amount = min(1, max(0, argNum(args, "amount") ?? 0.75))
        let spans = dialogueSpans(args: args, project: project)
        guard !spans.isEmpty else { return nil }
        var commands: [ProjectCommand] = []
        for clip in track.clips {
            let duration = clip.outputDuration(projectEnd: project.duration)
            let points = await AudioDucking.automation(
                spans: spans, musicClip: clip, musicDuration: duration.seconds, attenuation: 1 - amount)
            commands.append(.setAudioClipAutomation(clipID: clip.id, points: points))
        }
        return commands
    }

    private func executeDucking(args: [String: JSONValue], project: EditorProject) async -> ClientToolResult {
        guard let trackID = argID(args, "trackId") else { return failure("invalid_arguments") }
        guard project.audioTrack(trackID) != nil else { return failure("audio_track_not_found") }
        guard let commands = await duckingCommands(args: args, project: project), !commands.isEmpty else {
            return failure("invalid_arguments")
        }
        var affected: [UUID] = []
        for command in commands {
            guard let r = await performTimelineCommand(command) else { return failure(lastError ?? "invalid_arguments") }
            affected.append(contentsOf: r.affectedIDs)
        }
        guard let updated = timelineProject else { return failure("no_media") }
        return contractSuccess(updated, affected: affected)
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

    // MARK: Legacy single-clip tools on a timeline project

    /// Legacy single-clip tools, translated onto a timeline project. Returns nil when
    /// the tool has no project translation (the caller falls through to the legacy
    /// path). Frame/colour tools target the SELECTED clip; `resize_video` sets the
    /// canvas. Trim/speed translate only for a ONE-clip project, where their
    /// timeline-seconds semantics are unambiguous; on a multi-clip project the model
    /// is told to use the clip tools instead.
    func executeLegacyToolOnProject(_ call: ClientToolCall) async -> ClientToolResult? {
        guard let project = timelineProject,
              project.videoClips.count > 1 || !project.audioTracks.isEmpty else { return nil }
        let args = call.arguments
        let selected = project.selectedClipID.flatMap { project.clip($0) } ?? project.videoClips.first
        func done(_ command: ProjectCommand) async -> ClientToolResult {
            guard let result = await performTimelineCommand(command) else {
                return failure(lastError ?? "invalid_arguments")
            }
            guard let updated = timelineProject else { return failure("no_media") }
            return contractSuccess(updated, affected: result.affectedIDs, createdClip: result.createdID)
        }
        switch call.name {
        case "crop_video", "rotate_video", "flip_video_horizontal", "flip_video_vertical",
             "adjust_brightness", "adjust_contrast", "adjust_saturation", "adjust_hue",
             "apply_color_filter", "add_text":
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
            guard let width = args["width"]?.doubleValue, let height = args["height"]?.doubleValue else { return nil }
            return await done(.setCanvas(width: Int(width), height: Int(height), fit: nil))
        case "trim_video":
            guard project.videoClips.count == 1, let clip = selected,
                  let start = args["start"]?.doubleValue, let end = args["end"]?.doubleValue else {
                return failure("invalid_arguments")
            }
            return await done(.trimVideoClip(clipID: clip.id, sourceStart: start, sourceEnd: end))
        case "adjust_speed":
            guard project.videoClips.count == 1, let clip = selected,
                  let speed = args["speed"]?.doubleValue ?? args["factor"]?.doubleValue else {
                return failure("invalid_arguments")
            }
            return await done(.setVideoClipSpeed(clipID: clip.id, speed: speed))
        case "adjust_audio_volume":
            guard let clip = selected, let volume = args["volume"]?.doubleValue else { return nil }
            return await done(.setVideoClipOriginalAudio(clipID: clip.id, enabled: volume > 0, gain: volume))
        case "audio_fade":
            guard let clip = selected,
                  let fadeIn = args["fade_in"]?.doubleValue, let fadeOut = args["fade_out"]?.doubleValue else { return nil }
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
            isPhoto: false,
            hasAudio: asset?.hasAudio ?? false)
    }
}
