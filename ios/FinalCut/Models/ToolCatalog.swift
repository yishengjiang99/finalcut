import Foundation

/// Tool names/required args from the server's versioned schema
/// (`GET /api/tools/schema`, committed as `docs/api/tools-schema.v1.json`),
/// plus how iOS executes each tool call today (server jobs API, captions flow, or locally).
///
/// Rule: a tool is **never** sent to the server with missing required args.
enum ToolCatalog {
    static let schemaVersion = "1"

    static let requiredArgs: [String: [String]] = [
        "resize_video": ["width", "height"],
        "crop_video": ["x", "y", "width", "height"],
        "rotate_video": ["angle"],
        "flip_video_horizontal": [],
        "add_text": ["text"],
        "trim_video": ["start", "end"],
        "adjust_speed": ["speed"],
        "add_audio_track": ["audioFile"],
        "adjust_audio_volume": ["volume"],
        "audio_fade": ["type", "duration"],
        "audio_highpass": ["frequency"],
        "audio_lowpass": ["frequency"],
        "audio_echo": ["delay", "decay"],
        "adjust_bass": ["gain"],
        "adjust_treble": ["gain"],
        "audio_equalizer": ["frequency", "gain"],
        "normalize_audio": ["target"],
        "audio_delay": ["delay"],
        "audio_chorus": [],
        "audio_flanger": [],
        "audio_phaser": [],
        "audio_vibrato": [],
        "audio_tremolo": [],
        "audio_compressor": [],
        "audio_dynamic_normalize": [],
        "audio_gate": [],
        "audio_stereo_widen": [],
        "audio_reverse": [],
        "audio_limiter": [],
        "audio_silence_remove": [],
        "audio_pan": ["pan"],
        "resize_video_preset": ["preset"],
        "adjust_brightness": ["brightness"],
        "adjust_hue": ["degrees"],
        "adjust_saturation": ["saturation"],
        "get_video_dimensions": [],
        "convert_video_format": ["format"],
        "convert_audio_format": ["format"],
        "extract_audio": [],
        "get_supported_formats": [],
        "generate_captions": [],
        "add_video_transition": ["transition"],
        "apply_color_filter": ["filter"],
        "adjust_contrast": ["contrast"],
        "flip_video_vertical": [],
        "convert_image_format": ["format"],
    ]

    /// Legacy web `toolFunctions` names → schema names.
    static let aliases: [String: String] = [
        "adjust_volume": "adjust_audio_volume",
        "highpass_filter": "audio_highpass",
        "lowpass_filter": "audio_lowpass",
        "echo_effect": "audio_echo",
        "bass_adjustment": "adjust_bass",
        "treble_adjustment": "adjust_treble",
        "equalizer": "audio_equalizer",
        "delay_audio": "audio_delay",
        "get_video_info": "get_video_dimensions",
    ]

    /// Schema tool name → `ffmpegOps` operation when they differ.
    static let serverOperation: [String: String] = [
        "adjust_speed": "speed_video",
        "adjust_audio_volume": "adjust_volume",
        "audio_highpass": "highpass_filter",
        "audio_lowpass": "lowpass_filter",
        "audio_echo": "echo_effect",
        "adjust_bass": "bass_adjustment",
        "adjust_treble": "treble_adjustment",
        "audio_equalizer": "equalizer",
        "audio_delay": "delay_audio",
        "resize_video_preset": "resize_video",
    ]

    static let presetSizes: [String: (width: Int, height: Int)] = [
        "9:16": (1080, 1920), "16:9": (1920, 1080), "1:1": (1080, 1080),
        "2:3": (1080, 1620), "3:2": (1620, 1080),
    ]

    /// Tools the jobs API cannot run for iOS yet (secondary inputs / multi-clip).
    static let unavailableOnIOS: Set<String> = ["add_audio_track", "add_video_transition"]

    /// Server operations that accept photos (docs/PHOTO_SUPPORT.md). Everything else on a
    /// photo is answered locally with `unsupported_for_photo` without uploading.
    static let photoSupportedOperations: Set<String> = [
        "resize_video", "crop_video", "rotate_video", "flip_video_horizontal", "flip_video_vertical",
        "add_text", "adjust_brightness", "adjust_contrast", "adjust_hue", "adjust_saturation",
        "apply_color_filter", "convert_image_format",
    ]

    static func canonicalName(_ name: String) -> String {
        aliases[name] ?? name
    }

    static func isKnown(_ name: String) -> Bool {
        requiredArgs[canonicalName(name)] != nil
    }

    /// Required args that are absent, null, or empty strings.
    static func missingRequiredArgs(tool: String, arguments: [String: JSONValue]) -> [String] {
        let required = requiredArgs[canonicalName(tool)] ?? []
        return required.filter { key in
            guard let value = arguments[key] else { return true }
            switch value {
            case .null: return true
            case .string(let s): return s.trimmingCharacters(in: .whitespaces).isEmpty
            default: return false
            }
        }
    }

    enum Plan: Equatable {
        /// Run on the server jobs API with this operation + args.
        case serverJob(operation: String, args: [String: JSONValue])
        /// Run the captions three-step flow (generate → translate? → burn?).
        case captions(language: String, translateLanguage: String?, burnIn: Bool)
        /// Answered on device without an upload.
        case localQuery(tool: String)
        /// Not executed; returned to the model as `{ ok: false, error }`.
        case reject(error: String)
    }

    /// Decide how to execute a model tool call. `mediaDuration` (seconds) lets us fill
    /// `audio_fade.start`, which the server reads but the schema doesn't expose.
    static func plan(
        tool rawName: String,
        arguments: [String: JSONValue],
        mediaDuration: Double? = nil,
        isPhoto: Bool = false
    ) -> Plan {
        let plan = basePlan(tool: rawName, arguments: arguments, mediaDuration: mediaDuration)
        guard isPhoto else { return plan }
        switch plan {
        case .serverJob(let operation, _) where !photoSupportedOperations.contains(operation):
            return .reject(error: ServerErrorCode.unsupportedForPhoto)
        case .captions:
            return .reject(error: ServerErrorCode.unsupportedForPhoto)
        default:
            return plan
        }
    }

    private static func basePlan(tool rawName: String, arguments: [String: JSONValue], mediaDuration: Double?) -> Plan {
        let tool = canonicalName(rawName)
        guard requiredArgs[tool] != nil else { return .reject(error: "unknown_tool") }
        let missing = missingRequiredArgs(tool: tool, arguments: arguments)
        if !missing.isEmpty {
            return .reject(error: "missing_required_args: \(missing.joined(separator: ", "))")
        }
        if unavailableOnIOS.contains(tool) {
            return .reject(error: "not_available_on_ios")
        }
        switch tool {
        case "get_video_dimensions", "get_supported_formats":
            return .localQuery(tool: tool)
        case "generate_captions":
            let language = arguments["language"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? "auto"
            let translate = arguments["translate_language"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
            let burnIn = arguments["burn_in"]?.boolValue ?? true
            return .captions(language: language, translateLanguage: translate, burnIn: burnIn)
        case "resize_video_preset":
            guard let preset = arguments["preset"]?.stringValue, let size = presetSizes[preset] else {
                return .reject(error: "invalid_arguments: preset must be one of \(presetSizes.keys.sorted().joined(separator: ", "))")
            }
            return .serverJob(operation: "resize_video", args: [
                "width": .number(Double(size.width)),
                "height": .number(Double(size.height)),
            ])
        case "audio_fade":
            var args = arguments
            if args["start"] == nil {
                let duration = args["duration"]?.doubleValue ?? 0
                let isOut = args["type"]?.stringValue == "out"
                let start = isOut ? max(0, (mediaDuration ?? duration) - duration) : 0
                args["start"] = .number(start)
            }
            return .serverJob(operation: "audio_fade", args: args)
        default:
            return .serverJob(operation: serverOperation[tool] ?? tool, args: arguments)
        }
    }
}

/// Where a composer message goes. Only exact sample-chip taps take a local shortcut;
/// all other free text is sent to the server chat so the model picks the tool and args.
enum EditorRoute: Equatable {
    case captions(EditorViewModel.CaptionIntent)
    case tool(name: String, arguments: [String: JSONValue])
    case chat(String)

    /// Sample chips shown under the chat. Each maps to a correct tool/flow with complete args.
    static let sampleChips = [
        "Generate captions",
        "Translate to Spanish",
        "Burn in",
        "Red filter",
        "Trim silence",
    ]

    /// Photo-safe chips (NATIVE_EDIT_UX.md §7).
    static let photoChips = [
        "Make it warm",
        "Black and white",
        "More contrast",
    ]

    static func chips(isPhoto: Bool) -> [String] {
        isPhoto ? photoChips : sampleChips
    }

    static func route(for text: String) -> EditorRoute {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        switch trimmed.lowercased() {
        case "make it warm":
            return .tool(name: "apply_color_filter", arguments: ["filter": .string("warm")])
        case "black and white":
            return .tool(name: "apply_color_filter", arguments: ["filter": .string("grayscale")])
        case "more contrast":
            return .tool(name: "adjust_contrast", arguments: ["contrast": .number(1.3)])
        case "generate captions":
            return .captions(.generate)
        case "translate to spanish":
            return .captions(.translate(language: "Spanish"))
        case "burn in":
            return .captions(.burnIn)
        case "red filter":
            return .tool(name: "apply_color_filter", arguments: ["filter": .string("red")])
        case "trim silence":
            return .tool(name: "audio_silence_remove", arguments: [:])
        default:
            return .chat(trimmed)
        }
    }
}
