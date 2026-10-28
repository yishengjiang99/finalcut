import AVFoundation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Timeline workspace, layout rethink (2026-10-27 mockup, approved by the user).
/// The timeline is the hero surface in edit focus: a ruler + tall filmstrip video lane +
/// visible audio lanes share ONE horizontal scroll view (so lanes can never drift out of
/// sync), a playhead line rides the content, trim happens with edge handles on the
/// selected clip, and clip actions live in a single contextual row. In chat focus the
/// editor mounts this view `compact` — lanes only, no header or controls — and a tap
/// asks the editor to return to edit focus. Every control dispatches a `ProjectCommand`
/// through the view model — the exact same validated, undoable mutations the AI tools
/// use; there is no UI-only editing path.
struct TimelineView: View {
    @ObservedObject var model: EditorViewModel
    /// Compact strip for chat focus: lanes only.
    var compact: Bool = false
    /// Called when the compact strip is tapped.
    var onExpand: (() -> Void)? = nil

    /// Ruler position while a scrub drag is in flight; the model's playhead otherwise.
    @State private var scrubPosition: Double?
    @State private var showAudioImporter = false
    @State private var thumbnails: [UUID: [UIImage]] = [:]
    @State private var zoom: Double = 1
    @State private var zoomAnchor: Double? = nil
    @State private var trimClipID: UUID?
    @State private var trimOrigin: (start: Double, end: Double)?
    @State private var trimPreview: (start: Double, end: Double)?

    private var project: EditorProject? { model.timelineProject }
    private var duration: Double { project?.durationSeconds ?? model.editStack?.canvas.duration ?? 0 }
    private var pointsPerSecond: Double { 16 * zoom }
    /// The playhead lives on the model (`seekSeconds`) so the seek_playhead tool moves it too.
    private var playhead: Double { scrubPosition ?? model.seekSeconds ?? 0 }
    private var videoLaneHeight: CGFloat { compact ? 52 : 84 }
    private var audioLaneHeight: CGFloat { compact ? 26 : 40 }

    var body: some View {
        VStack(spacing: 6) {
            if !compact {
                header
            }
            if model.showTimeline, let project {
                lanesStack(project)
                if !compact {
                    if let clip = selectedVideoClip(project) { videoClipControls(clip, project: project) }
                    if let found = selectedAudioClip(project) { audioClipControls(found.clip, track: found.track) }
                    zoomRow
                    if let status = model.importStatus {
                        Text(status).font(.caption).foregroundStyle(AppTheme.textSecondary)
                    }
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, compact ? 4 : 6)
        .background(AppTheme.surface)
        .fileImporter(isPresented: $showAudioImporter,
                      allowedContentTypes: [.audio, .mp3, .mpeg4Audio, .wav, .movie],
                      allowsMultipleSelection: true) { result in
            if case .success(let urls) = result {
                Task { await model.importMediaFiles(urls) }
            }
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 8) {
            Button {
                withAnimation { model.showTimeline.toggle() }
                if model.showTimeline { Task { _ = await model.ensureTimelineProject() } }
            } label: {
                Label("Timeline", systemImage: model.showTimeline ? "chevron.down" : "chevron.right")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppTheme.textPrimary)
            }
            .accessibilityIdentifier("TimelineToggle")
            .layoutPriority(1)
            if let project {
                Text("\(String(format: "%.1fs", duration)) · \(project.videoClips.count) clips · \(project.audioTracks.reduce(0) { $0 + $1.clips.count }) audio")
                    .font(.caption)
                    .foregroundStyle(AppTheme.textSecondary)
                    .lineLimit(1)
            } else {
                Text(String(format: "%.1fs", duration))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(AppTheme.textSecondary)
            }
            Spacer(minLength: 2)
            PhotosPicker(selection: $model.photosPickerItems, matching: .videos, photoLibrary: .shared()) {
                Image(systemName: "plus.rectangle.on.rectangle").font(.subheadline)
            }
            .accessibilityLabel("Add videos from Photos")
            Button {
                showAudioImporter = true
            } label: {
                Image(systemName: "music.note").font(.subheadline)
            }
            .accessibilityLabel("Add audio files")
            Menu {
                Button("New project", systemImage: "doc.badge.plus") { model.startNewTimelineProject() }
                Button("Save project", systemImage: "square.and.arrow.down") { model.saveTimelineProject() }
            } label: {
                Image(systemName: "ellipsis.circle").font(.subheadline)
            }
            .accessibilityLabel("Project actions")
        }
    }

    // MARK: Lanes (one shared scroll view: ruler + video + audio stay in sync)

    private func lanesStack(_ project: EditorProject) -> some View {
        let contentWidth = CGFloat(max(duration * pointsPerSecond, 1))
        return ZStack(alignment: .topLeading) {
            ScrollView(.horizontal, showsIndicators: false) {
                ZStack(alignment: .topLeading) {
                    VStack(alignment: .leading, spacing: 6) {
                        ruler(width: contentWidth)
                        videoLane(project)
                        ForEach(project.audioTracks) { track in
                            audioTrackBlock(track, project: project, contentWidth: contentWidth)
                        }
                    }
                    .frame(width: contentWidth, alignment: .leading)
                    playheadOverlay
                }
            }
            .simultaneousGesture(magnificationGesture)
        }
        .contentShape(Rectangle())
        .onTapGesture {
            if compact { onExpand?() }
        }
    }

    private var magnificationGesture: some Gesture {
        MagnificationGesture()
            .onChanged { value in
                if zoomAnchor == nil { zoomAnchor = zoom }
                zoom = min(4, max(0.5, (zoomAnchor ?? zoom) * Double(value)))
            }
            .onEnded { _ in zoomAnchor = nil }
    }

    private var rulerStep: Double {
        let target = 48 / max(pointsPerSecond, 1)
        return [1, 2, 5, 10, 15, 30, 60].first { $0 >= target } ?? 60
    }

    private func ruler(width: CGFloat) -> some View {
        let ticks = Array(stride(from: 0.0, through: max(duration, rulerStep), by: rulerStep))
        return ZStack(alignment: .topLeading) {
            Color.clear
            ForEach(ticks, id: \.self) { t in
                VStack(alignment: .leading, spacing: 1) {
                    Text(timeLabel(t))
                        .font(.system(size: 9.5))
                        .foregroundStyle(AppTheme.textSecondary)
                    Rectangle()
                        .fill(AppTheme.textSecondary.opacity(0.6))
                        .frame(width: 1, height: 5)
                }
                .offset(x: CGFloat(t * pointsPerSecond))
            }
        }
        .frame(width: width, height: 24, alignment: .leading)
        .contentShape(Rectangle())
        .highPriorityGesture(
            DragGesture(minimumDistance: 0)
                .onChanged { value in
                    scrubPosition = min(max(0, Double(value.location.x) / pointsPerSecond), duration)
                }
                .onEnded { _ in
                    if let scrubPosition { model.seekPlayhead(to: scrubPosition) }
                    scrubPosition = nil
                }
        )
        .accessibilityLabel("Playhead")
    }

    private var playheadOverlay: some View {
        let x = CGFloat(playhead * pointsPerSecond)
        return ZStack(alignment: .topLeading) {
            Rectangle()
                .fill(Color.red)
                .frame(width: 2)
            Text(timeLabel(playhead))
                .font(.system(size: 9.5, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 44)
                .padding(.vertical, 1.5)
                .background(Capsule().fill(Color.red))
                .offset(x: -22)
        }
        .offset(x: x - 1)
        .allowsHitTesting(false)
    }

    private func timeLabel(_ t: Double) -> String {
        let s = max(0, Int(t.rounded()))
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    // MARK: Video lane

    private func videoLane(_ project: EditorProject) -> some View {
        HStack(spacing: 4) {
            ForEach(Array(project.videoClips.enumerated()), id: \.element.id) { index, clip in
                clipCard(clip, index: index, project: project)
            }
        }
    }

    private func clipCard(_ clip: VideoClip, index: Int, project: EditorProject) -> some View {
        let isTrimming = trimClipID == clip.id
        let start = isTrimming ? (trimPreview?.start ?? clip.sourceStart.seconds) : clip.sourceStart.seconds
        let end = isTrimming ? (trimPreview?.end ?? clip.sourceEnd.seconds) : clip.sourceEnd.seconds
        let outSeconds = max(0.1, (end - start) / max(clip.speed, 0.01))
        let width = CGFloat(max(44, outSeconds * pointsPerSecond))
        let height = videoLaneHeight
        let selected = project.selectedClipID == clip.id
        let controlsHere = !compact && selectedVideoClip(project)?.id == clip.id
        let assetDuration = project.asset(clip.assetID)?.duration.seconds ?? clip.sourceEnd.seconds
        return ZStack(alignment: .bottomLeading) {
            if let frames = thumbnails[clip.id], !frames.isEmpty {
                HStack(spacing: 1) {
                    ForEach(Array(frames.enumerated()), id: \.offset) { _, image in
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFill()
                            .frame(width: max(12, (width - 2) / 3), height: height)
                            .clipped()
                    }
                }
            } else {
                AppTheme.surfaceElevated
                Image(systemName: "film")
                    .foregroundStyle(AppTheme.textSecondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            // Filmstrip perforation ticks.
            HStack(spacing: 44) {
                ForEach(0..<max(1, Int(width / 45)), id: \.self) { _ in
                    Rectangle().fill(Color.black.opacity(0.22)).frame(width: 1)
                }
            }
            .frame(width: width, height: height)
            .allowsHitTesting(false)
            Text(String(format: "%.1fs", outSeconds))
                .font(.caption2.monospacedDigit().weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(Color.black.opacity(0.55))
                .clipShape(RoundedRectangle(cornerRadius: 4))
                .padding(5)
            if controlsHere {
                HStack(spacing: 0) {
                    trimHandle(isStart: true, clip: clip, assetDuration: assetDuration)
                    Spacer()
                    trimHandle(isStart: false, clip: clip, assetDuration: assetDuration)
                }
                .frame(width: width, height: height)
            }
        }
        .frame(width: width, height: height)
        .background(AppTheme.surfaceElevated)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8)
            .stroke(selected ? AppTheme.accent : AppTheme.border, lineWidth: selected ? 2.5 : 1))
        .onTapGesture {
            Task { _ = await model.performTimelineCommand(.selectClip(clipID: clip.id)) }
        }
        .accessibilityLabel("Clip \(index + 1), \(String(format: "%.1f", outSeconds)) seconds")
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .task {
            await loadThumbnails(for: clip, project: project, width: width)
        }
    }

    /// Three frames across the clip's source range (start / middle / end) make a real
    /// filmstrip instead of one stretched thumbnail, at a decode size matched to the
    /// card so the frames stay legible.
    private func loadThumbnails(for clip: VideoClip, project: EditorProject, width: CGFloat) async {
        guard thumbnails[clip.id] == nil, let asset = project.asset(clip.assetID) else { return }
        let url = NativeComposer.resolveAssetURL(asset, in: project)
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: CGFloat(min(720, max(240, Double(width) * 2))), height: 240)
        generator.requestedTimeToleranceBefore = CMTime(seconds: 0.25, preferredTimescale: 600)
        generator.requestedTimeToleranceAfter = CMTime(seconds: 0.25, preferredTimescale: 600)
        let range = max(0, clip.sourceDuration.seconds)
        var frames: [UIImage] = []
        for fraction in [0.08, 0.5, 0.92] {
            let time = CMTimeAdd(clip.sourceStart.cmTime,
                                 CMTime(seconds: range * fraction, preferredTimescale: 600))
            if let image = try? await generator.image(at: time).image {
                frames.append(UIImage(cgImage: image))
            }
        }
        if !frames.isEmpty {
            thumbnails[clip.id] = frames
        }
    }

    private func trimHandle(isStart: Bool, clip: VideoClip, assetDuration: Double) -> some View {
        Rectangle()
            .fill(AppTheme.accent)
            .frame(width: 14)
            .overlay(
                Image(systemName: isStart ? "chevron.left" : "chevron.right")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.white)
            )
            .highPriorityGesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { value in
                        if trimClipID != clip.id {
                            trimClipID = clip.id
                            trimOrigin = (start: clip.sourceStart.seconds, end: clip.sourceEnd.seconds)
                        }
                        guard let origin = trimOrigin else { return }
                        let delta = Double(value.translation.width) / pointsPerSecond
                        if isStart {
                            let newStart = min(max(0, origin.start + delta), origin.end - 0.2)
                            trimPreview = (start: newStart, end: origin.end)
                        } else {
                            let newEnd = max(min(assetDuration, origin.end + delta), origin.start + 0.2)
                            trimPreview = (start: origin.start, end: newEnd)
                        }
                    }
                    .onEnded { _ in
                        if let preview = trimPreview {
                            Task {
                                _ = await model.performTimelineCommand(.trimVideoClip(
                                    clipID: clip.id, sourceStart: preview.start, sourceEnd: preview.end))
                            }
                        }
                        trimPreview = nil
                        trimOrigin = nil
                        trimClipID = nil
                    }
            )
            .accessibilityLabel(isStart ? "Trim clip start" : "Trim clip end")
    }

    private func selectedVideoClip(_ project: EditorProject) -> VideoClip? {
        guard let id = project.selectedClipID else { return project.videoClips.first }
        return project.clip(id)
    }

    /// One contextual row for the selected clip (was: two permanent rows + a separate
    /// global Trim slider; trimming now lives on the clip's edge handles).
    private func videoClipControls(_ clip: VideoClip, project: EditorProject) -> some View {
        let index = project.clipIndex(clip.id) ?? 0
        return VStack(alignment: .leading, spacing: 4) {
            Text("Clip \(index + 1) of \(project.videoClips.count) · \(String(format: "%.1fs", clip.outputDuration.seconds))")
                .font(.caption.weight(.semibold))
                .foregroundStyle(AppTheme.textSecondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 14) {
                    controlButton("Split", "scissors") {
                        await model.performTimelineCommand(.splitVideoClip(clipID: clip.id, atProjectTime: playhead))
                    }
                    controlButton("Duplicate", "plus.square.on.square") {
                        await model.performTimelineCommand(.duplicateVideoClip(clipID: clip.id))
                    }
                    controlButton("Move left", "arrow.left") {
                        guard index > 0 else { return }
                        var ids = project.videoClips.map(\.id)
                        ids.swapAt(index, index - 1)
                        _ = await model.performTimelineCommand(.reorderVideoClips(orderedIDs: ids))
                    }
                    controlButton("Move right", "arrow.right") {
                        guard index + 1 < project.videoClips.count else { return }
                        var ids = project.videoClips.map(\.id)
                        ids.swapAt(index, index + 1)
                        _ = await model.performTimelineCommand(.reorderVideoClips(orderedIDs: ids))
                    }
                    Menu {
                        ForEach([0.5, 1.0, 1.5, 2.0], id: \.self) { speed in
                            Button("\(speed, specifier: "%.1f")×") {
                                Task { _ = await model.performTimelineCommand(.setVideoClipSpeed(clipID: clip.id, speed: speed)) }
                            }
                        }
                    } label: { menuLabel("Speed \(clip.speed.formatted())×", "gauge") }
                    Menu {
                        Button("Cut") { setTransition(clip, .cut) }
                        Button("Cross-dissolve 0.5s") {
                            setTransition(clip, TransitionSpec(kind: .crossDissolve, duration: .seconds(0.5)))
                        }
                        Button("Fade through black 0.5s") {
                            setTransition(clip, TransitionSpec(kind: .fadeThroughBlack, duration: .seconds(0.5)))
                        }
                    } label: { menuLabel("Transition", "arrow.triangle.swap") }
                    controlButton(clip.originalAudioEnabled ? "Mute audio" : "Unmute audio",
                                  clip.originalAudioEnabled ? "speaker.wave.2" : "speaker.slash") {
                        await model.performTimelineCommand(.setVideoClipOriginalAudio(
                            clipID: clip.id, enabled: !clip.originalAudioEnabled, gain: nil))
                    }
                    controlButton("B&W", "camera.filters") {
                        await model.performTimelineCommand(.applyClipEffect(
                            clipID: clip.id, effect: .colorFilter(filter: "grayscale", intensity: 1)))
                    }
                    controlButton("Delete", "trash") {
                        await model.performTimelineCommand(.removeVideoClip(clipID: clip.id))
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }

    private func setTransition(_ clip: VideoClip, _ spec: TransitionSpec) {
        Task { _ = await model.performTimelineCommand(.setVideoClipTransition(clipID: clip.id, transition: spec)) }
    }

    private var zoomRow: some View {
        HStack(spacing: 10) {
            Text("Drag the ruler to scrub · pinch to zoom")
                .font(.caption2)
                .foregroundStyle(AppTheme.textSecondary)
            Spacer()
            Button {
                zoom = max(0.5, zoom / 1.3)
            } label: {
                Image(systemName: "minus.magnifyingglass")
            }
            .accessibilityLabel("Zoom timeline out")
            Button {
                zoom = min(4, zoom * 1.3)
            } label: {
                Image(systemName: "plus.magnifyingglass")
            }
            .accessibilityLabel("Zoom timeline in")
        }
        .font(.caption)
        .foregroundStyle(AppTheme.textSecondary)
    }

    // MARK: Audio lanes

    private func audioTrackBlock(_ track: AudioTrack, project: EditorProject, contentWidth: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            if !compact {
                HStack(spacing: 8) {
                    Text(track.name).font(.caption.weight(.semibold)).foregroundStyle(AppTheme.textPrimary)
                    Button {
                        Task { _ = await model.performTimelineCommand(.setAudioTrackMuted(trackID: track.id, muted: !track.muted)) }
                    } label: {
                        Image(systemName: track.muted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                            .font(.caption)
                    }
                    .accessibilityLabel(track.muted ? "Unmute \(track.name)" : "Mute \(track.name)")
                    Slider(value: Binding(
                        get: { track.gain },
                        set: { newGain in Task { _ = await model.performTimelineCommand(.setAudioTrackVolume(trackID: track.id, gain: newGain)) } }),
                           in: 0...1.5)
                        .frame(maxWidth: 110)
                        .accessibilityLabel("\(track.name) volume")
                    Spacer()
                }
                .frame(width: contentWidth, alignment: .leading)
            }
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 6)
                    .fill(AppTheme.surfaceElevated)
                    .frame(width: contentWidth, height: audioLaneHeight)
                ForEach(track.clips) { clip in
                    audioClipBar(clip, track: track, project: project)
                }
            }
            .frame(width: contentWidth, height: audioLaneHeight)
        }
    }

    private func audioClipBar(_ clip: AudioClip, track: AudioTrack, project: EditorProject) -> some View {
        let x = CGFloat(clip.timelineStart.seconds * pointsPerSecond)
        let width = CGFloat(max(24, clip.sourceDuration.seconds * pointsPerSecond))
        let selected = project.selectedAudioClipID == clip.id
        let barHeight = audioLaneHeight - 6
        return ZStack {
            RoundedRectangle(cornerRadius: 5)
                .fill(Color.green.opacity(selected ? 0.45 : 0.30))
            waveform(seed: clip.id, width: width, maxHeight: max(8, barHeight - 10))
                .padding(.horizontal, 4)
        }
        .frame(width: width, height: barHeight)
        .overlay(RoundedRectangle(cornerRadius: 5)
            .stroke(selected ? AppTheme.accent : Color.clear, lineWidth: 1.5))
        .offset(x: x, y: 3)
        .onTapGesture {
            Task { _ = await model.performTimelineCommand(.selectClip(clipID: clip.id)) }
        }
        .accessibilityLabel("Audio clip at \(String(format: "%.1f", clip.timelineStart.seconds)) seconds")
    }

    /// Deterministic pseudo-waveform (decorative): an LCG seeded from the clip id, so
    /// the bars are stable across renders without decoding the audio file.
    private func waveform(seed: UUID, width: CGFloat, maxHeight: CGFloat) -> some View {
        let count = max(4, Int(width / 4))
        var state: UInt64 = seed.uuidString.unicodeScalars.reduce(1469598103934665603) {
            ($0 ^ UInt64($1.value)) &* 1099511628211
        }
        var heights: [CGFloat] = []
        heights.reserveCapacity(count)
        for _ in 0..<count {
            state = state &* 6364136223846793005 &+ 1442695040888963407
            let r = Double((state >> 33) % 1000) / 1000.0
            heights.append(CGFloat(0.25 + 0.75 * r) * maxHeight)
        }
        return HStack(alignment: .center, spacing: 2) {
            ForEach(Array(heights.enumerated()), id: \.offset) { _, h in
                RoundedRectangle(cornerRadius: 1)
                    .fill(Color.white.opacity(0.55))
                    .frame(width: 2, height: h)
            }
        }
    }

    private func selectedAudioClip(_ project: EditorProject) -> (track: AudioTrack, clip: AudioClip)? {
        guard let id = project.selectedAudioClipID else { return nil }
        return project.audioClip(id)
    }

    private func audioClipControls(_ clip: AudioClip, track: AudioTrack) -> some View {
        VStack(spacing: 6) {
            HStack(spacing: 8) {
                Text("Audio").font(.caption).foregroundStyle(AppTheme.textSecondary)
                Slider(value: Binding(
                    get: { clip.gain },
                    set: { newGain in Task { _ = await model.performTimelineCommand(.setAudioClipVolume(clipID: clip.id, gain: newGain)) } }),
                       in: 0...1.5)
                    .accessibilityLabel("Audio clip volume")
                controlButton("Delete", "trash") {
                    await model.performTimelineCommand(.removeAudioClip(clipID: clip.id))
                }
                controlButton(clip.loop ? "Looping" : "Loop", "repeat") {
                    await model.performTimelineCommand(.loopAudioClip(clipID: clip.id, repeatUntil: nil))
                }
            }
            HStack(spacing: 16) {
                Stepper("Fade in \(clip.fadeIn.formatted())s", value: Binding(
                    get: { clip.fadeIn },
                    set: { newValue in Task { _ = await model.performTimelineCommand(.setAudioFade(clipID: clip.id, isIn: true, duration: newValue)) } }),
                        in: 0...5, step: 0.5)
                    .font(.caption)
                Stepper("Fade out \(clip.fadeOut.formatted())s", value: Binding(
                    get: { clip.fadeOut },
                    set: { newValue in Task { _ = await model.performTimelineCommand(.setAudioFade(clipID: clip.id, isIn: false, duration: newValue)) } }),
                        in: 0...5, step: 0.5)
                    .font(.caption)
            }
        }
    }

    // MARK: Bits

    private func controlButton(_ label: String, _ systemImage: String, action: @escaping () async -> Void) -> some View {
        Button {
            Task { await action() }
        } label: {
            VStack(spacing: 2) {
                Image(systemName: systemImage)
                Text(label).font(.caption2)
            }
            .foregroundStyle(AppTheme.textPrimary)
        }
        .accessibilityLabel(label)
    }

    private func menuLabel(_ label: String, _ systemImage: String) -> some View {
        VStack(spacing: 2) {
            Image(systemName: systemImage)
            Text(label).font(.caption2)
        }
        .foregroundStyle(AppTheme.textPrimary)
    }
}
