import AVFoundation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Compact timeline workspace (Phase D). Chat-first: a one-line bar that expands into
/// the video lane + audio lanes when tapped, never taking the whole screen. Every
/// control dispatches a `ProjectCommand` through the view model — the exact same
/// validated, undoable mutations the AI tools use; there is no UI-only editing path.
struct TimelineView: View {
    @ObservedObject var model: EditorViewModel
    @State private var playhead: Double = 0
    @State private var showAudioImporter = false
    @State private var thumbnails: [UUID: UIImage] = [:]

    private var project: EditorProject? { model.timelineProject }
    private var duration: Double { project?.durationSeconds ?? model.editStack?.canvas.duration ?? 0 }
    private var pointsPerSecond: Double { 16 }

    var body: some View {
        VStack(spacing: 6) {
            header
            if model.showTimeline, let project {
                scrubber
                videoLane(project)
                if let clip = selectedVideoClip(project) { videoClipControls(clip, project: project) }
                ForEach(project.audioTracks) { track in
                    audioLane(track, project: project)
                }
                if let found = selectedAudioClip(project) { audioClipControls(found.clip, track: found.track) }
                if let status = model.importStatus {
                    Text(status).font(.caption).foregroundStyle(AppTheme.textSecondary)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
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
        HStack(spacing: 10) {
            Button {
                withAnimation { model.showTimeline.toggle() }
                if model.showTimeline { Task { _ = await model.ensureTimelineProject() } }
            } label: {
                Label("Timeline", systemImage: model.showTimeline ? "chevron.down" : "chevron.right")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppTheme.textPrimary)
            }
            .accessibilityIdentifier("TimelineToggle")
            Text(String(format: "%.1fs", duration))
                .font(.caption.monospacedDigit())
                .foregroundStyle(AppTheme.textSecondary)
            if let project {
                Text("\(project.videoClips.count) clips · \(project.audioTracks.reduce(0) { $0 + $1.clips.count }) audio")
                    .font(.caption)
                    .foregroundStyle(AppTheme.textSecondary)
            }
            Spacer()
            PhotosPicker(selection: $model.photosPickerItems, matching: .videos, photoLibrary: .shared()) {
                Label("Video", systemImage: "plus.rectangle.on.rectangle")
                    .font(.caption.weight(.semibold))
            }
            .accessibilityLabel("Add videos from Photos")
            Button {
                showAudioImporter = true
            } label: {
                Label("Audio", systemImage: "music.note")
                    .font(.caption.weight(.semibold))
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

    // MARK: Scrubber

    private var scrubber: some View {
        HStack(spacing: 8) {
            Image(systemName: "play.circle").foregroundStyle(AppTheme.textSecondary)
            Slider(value: $playhead, in: 0...max(duration, 0.1)) { editing in
                if !editing { model.seekSeconds = playhead }
            }
            .accessibilityLabel("Playhead")
            Text(String(format: "%.1fs", playhead))
                .font(.caption.monospacedDigit())
                .foregroundStyle(AppTheme.textSecondary)
        }
    }

    // MARK: Video lane

    private func videoLane(_ project: EditorProject) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(Array(project.videoClips.enumerated()), id: \.element.id) { index, clip in
                    clipCard(clip, index: index, project: project)
                }
            }
        }
        .frame(height: 56)
    }

    private func clipCard(_ clip: VideoClip, index: Int, project: EditorProject) -> some View {
        let width = max(52, clip.outputDuration.seconds * pointsPerSecond)
        let selected = project.selectedClipID == clip.id
        return VStack(spacing: 2) {
            ZStack {
                RoundedRectangle(cornerRadius: 6)
                    .fill(AppTheme.surfaceElevated)
                if let thumb = thumbnails[clip.id] {
                    Image(uiImage: thumb).resizable().scaledToFill()
                        .frame(width: width - 4, height: 34).clipped()
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                } else {
                    Image(systemName: "film").foregroundStyle(AppTheme.textSecondary)
                }
            }
            .frame(width: width, height: 36)
            Text(String(format: "%.1fs", clip.outputDuration.seconds))
                .font(.caption2.monospacedDigit())
                .foregroundStyle(AppTheme.textSecondary)
        }
        .padding(3)
        .background(RoundedRectangle(cornerRadius: 8)
            .stroke(selected ? AppTheme.accent : AppTheme.border, lineWidth: selected ? 2 : 1))
        .onTapGesture {
            Task { _ = await model.performTimelineCommand(.selectClip(clipID: clip.id)) }
        }
        .accessibilityLabel("Clip \(index + 1), \(String(format: "%.1f", clip.outputDuration.seconds)) seconds")
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .task {
            if thumbnails[clip.id] == nil, let asset = project.asset(clip.assetID) {
                let url = NativeComposer.resolveAssetURL(asset, in: project)
                let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
                generator.appliesPreferredTrackTransform = true
                generator.maximumSize = CGSize(width: 120, height: 80)
                let time = CMTimeAdd(clip.sourceStart.cmTime, CMTime(seconds: 0.1, preferredTimescale: 600))
                if let image = try? await generator.image(at: time).image {
                    thumbnails[clip.id] = UIImage(cgImage: image)
                }
            }
        }
    }

    private func selectedVideoClip(_ project: EditorProject) -> VideoClip? {
        guard let id = project.selectedClipID else { return project.videoClips.first }
        return project.clip(id)
    }

    private func videoClipControls(_ clip: VideoClip, project: EditorProject) -> some View {
        let index = project.clipIndex(clip.id) ?? 0
        return VStack(spacing: 6) {
            HStack(spacing: 12) {
                controlButton("Split", "scissors") {
                    await model.performTimelineCommand(.splitVideoClip(clipID: clip.id, atProjectTime: playhead))
                }
                controlButton("Duplicate", "plus.square.on.square") {
                    await model.performTimelineCommand(.duplicateVideoClip(clipID: clip.id))
                }
                controlButton("Delete", "trash") {
                    await model.performTimelineCommand(.removeVideoClip(clipID: clip.id))
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
            }
            HStack(spacing: 12) {
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
            }
            HStack(spacing: 8) {
                Text("Trim").font(.caption).foregroundStyle(AppTheme.textSecondary)
                Slider(
                    value: Binding(
                        get: { clip.sourceEnd.seconds - clip.sourceStart.seconds },
                        set: { newLength in
                            Task {
                                _ = await model.performTimelineCommand(.trimVideoClip(
                                    clipID: clip.id, sourceStart: clip.sourceStart.seconds,
                                    sourceEnd: clip.sourceStart.seconds + newLength))
                            }
                        }),
                    in: 0.2...max(0.3, (model.timelineProject?.asset(clip.assetID)?.duration.seconds ?? 1) - clip.sourceStart.seconds))
                .accessibilityLabel("Clip length")
                Text(String(format: "%.1fs", clip.sourceDuration.seconds / clip.speed))
                    .font(.caption.monospacedDigit()).foregroundStyle(AppTheme.textSecondary)
            }
        }
    }

    private func setTransition(_ clip: VideoClip, _ spec: TransitionSpec) {
        Task { _ = await model.performTimelineCommand(.setVideoClipTransition(clipID: clip.id, transition: spec)) }
    }

    // MARK: Audio lanes

    private func audioLane(_ track: AudioTrack, project: EditorProject) -> some View {
        VStack(spacing: 3) {
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
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 5).fill(AppTheme.surfaceElevated).frame(height: 26)
                ForEach(track.clips) { clip in
                    audioClipBar(clip, track: track, project: project)
                }
            }
            .frame(height: 26)
        }
    }

    private func audioClipBar(_ clip: AudioClip, track: AudioTrack, project: EditorProject) -> some View {
        let x = clip.timelineStart.seconds * pointsPerSecond
        let width = max(24, clip.sourceDuration.seconds * pointsPerSecond)
        let selected = project.selectedAudioClipID == clip.id
        return RoundedRectangle(cornerRadius: 4)
            .fill(AppTheme.accent.opacity(selected ? 0.55 : 0.3))
            .frame(width: width, height: 20)
            .offset(x: x, y: 3)
            .onTapGesture {
                Task { _ = await model.performTimelineCommand(.selectClip(clipID: clip.id)) }
            }
            .accessibilityLabel("Audio clip at \(String(format: "%.1f", clip.timelineStart.seconds)) seconds")
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
                    set: { Task { _ = await model.performTimelineCommand(.setAudioFade(clipID: clip.id, isIn: true, duration: $0)) } }),
                        in: 0...5, step: 0.5)
                    .font(.caption)
                Stepper("Fade out \(clip.fadeOut.formatted())s", value: Binding(
                    get: { clip.fadeOut },
                    set: { Task { _ = await model.performTimelineCommand(.setAudioFade(clipID: clip.id, isIn: false, duration: $0)) } }),
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
