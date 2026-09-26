import AVFoundation
import Foundation
import Speech
import UIKit

/// Continuous on-device dictation for the composer (Design #94/#96). Audio never leaves the
/// iPhone: recognition requires on-device mode and there is no server fallback.
/// Each finished request is handed to `onSend` and listening continues.
@MainActor
final class DictationController: ObservableObject {
    enum Status: Equatable {
        case idle
        case listening
        case permissionDenied
        case unavailable
    }

    @Published private(set) var status: Status = .idle
    /// Live transcript of the current utterance.
    @Published private(set) var transcript = ""

    var onTranscript: (String) -> Void = { _ in }
    var onSend: (String) -> Void = { _ in }

    private let recognizer: SFSpeechRecognizer?
    private let engine = AVAudioEngine()
    private let requestBox = RequestBox()
    private var task: SFSpeechRecognitionTask?
    private var generation = 0
    private var endpointer = DictationEndpointer(now: 0)
    private var ticker: Timer?
    private let clock: () -> TimeInterval

    init(clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.clock = clock
        recognizer = SFSpeechRecognizer(locale: .current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    }

    /// On-device recognition exists for this locale/device.
    var isSupported: Bool {
        guard let recognizer else { return false }
        return recognizer.supportsOnDeviceRecognition
    }

    var isListening: Bool { status == .listening }

    func toggle() {
        if isListening { stop() } else { Task { await start() } }
    }

    func start() async {
        guard !isListening else { return }
        guard isSupported, let recognizer, recognizer.isAvailable else {
            status = .unavailable
            return
        }
        guard await Self.requestPermissions() else {
            status = .permissionDenied
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            input.removeTap(onBus: 0)
            let box = requestBox
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                box.append(buffer)
            }
            engine.prepare()
            try engine.start()
        } catch {
            teardownAudio()
            status = .unavailable
            return
        }
        status = .listening
        endpointer = DictationEndpointer(now: clock())
        startRecognition()
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        ticker = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    /// Stops listening. Unsent text stays in the composer (tapping the field does this).
    func stop() {
        guard isListening else { return }
        ticker?.invalidate()
        ticker = nil
        generation += 1
        task?.cancel()
        task = nil
        requestBox.replace(with: nil)?.endAudio()
        teardownAudio()
        status = .idle
        transcript = ""
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    private func teardownAudio() {
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// New request/task for the next utterance; the engine keeps running.
    private func startRecognition() {
        guard let recognizer else { return }
        generation += 1
        let current = generation
        task?.cancel()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        requestBox.replace(with: request)?.endAudio()
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let failed = error != nil
            Task { @MainActor in
                self?.handle(text: text, isFinal: isFinal, failed: failed, generation: current)
            }
        }
    }

    private func handle(text: String?, isFinal: Bool, failed: Bool, generation current: Int) {
        guard current == generation, isListening else { return }
        if let text {
            transcript = text
            onTranscript(text)
            apply(endpointer.partial(text, isFinal: isFinal, now: clock()))
        }
        if (failed || isFinal) && isListening && current == generation {
            // Task ended without a send (e.g. no speech): keep listening with a fresh task.
            startRecognition()
        }
    }

    private func tick() {
        guard isListening else { return }
        apply(endpointer.tick(now: clock()))
    }

    private func apply(_ action: DictationEndpointer.Action) {
        switch action {
        case .none:
            break
        case .stop:
            stop()
        case .send(let text):
            transcript = ""
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onSend(text)
            startRecognition()
        }
    }

    private static func requestPermissions() async -> Bool {
        let speech: SFSpeechRecognizerAuthorizationStatus = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard speech == .authorized else { return false }
        return await AVAudioApplication.requestRecordPermission()
    }
}

/// The current recognition request, shared with the audio tap thread.
private final class RequestBox: @unchecked Sendable {
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        let current = request
        lock.unlock()
        current?.append(buffer)
    }

    /// Swaps in a new request and returns the old one.
    @discardableResult
    func replace(with new: SFSpeechAudioBufferRecognitionRequest?) -> SFSpeechAudioBufferRecognitionRequest? {
        lock.lock()
        defer { lock.unlock() }
        let old = request
        request = new
        return old
    }
}
