import AVFoundation
import AppKit
import Accelerate
import Foundation
import Speech

struct VoiceFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

func koreanTranscriber() async throws -> SpeechTranscriber {
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "ko-KR")) else {
        throw VoiceFailure("이 Mac에서 한국어 음성 인식을 사용할 수 없습니다. macOS와 음성 모델을 확인하세요.")
    }
    return SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
}

func installedTranscriber() async throws -> SpeechTranscriber {
    let transcriber = try await koreanTranscriber()
    let installed = await SpeechTranscriber.installedLocales
    guard installed.contains(where: { $0.identifier(.bcp47) == "ko-KR" }) else {
        throw VoiceFailure("한국어 모델을 설치하세요: .cache/voice/packing-voice --install-ko")
    }
    return transcriber
}

// SpeechDetector gates the transcriber internally. Its public results stream only reports errors.
// Measure sound above the room floor for the endpoint clock, including speech before the first partial.
struct Endpoint {
    var elapsed = 0.0
    var decoderDeadline = 6.0
    var lastSound: Double?
    var noise = -62.0
    var loudDuration = 0.0
    var partial = ""
    private var low = Double.infinity
    private var high = -Double.infinity
    private var window = 0.0

    mutating func recognized(_ text: String) {
        if !text.isEmpty && text != partial {
            partial = text
            if lastSound == nil { lastSound = elapsed }
        }
    }

    mutating func frame(db: Double, seconds: Double) {
        elapsed += seconds
        if db > max(-55, noise + 10) {
            loudDuration += seconds
            if loudDuration >= 0.06 {
                let onset = elapsed - loudDuration
                if onset <= 6 { decoderDeadline = max(decoderDeadline, onset + 3) }
                lastSound = elapsed
            }
        } else {
            loudDuration = 0
        }
        // A steady fan or conveyor is part of the floor even when it is much louder than silence.
        // Ignore upward swings in windows containing modulated speech.
        low = min(low, db)
        high = max(high, db)
        window += seconds
        if window >= 0.4 {
            if high - low < 5 || low < noise { noise = min(-18, low) }
            low = .infinity
            high = -.infinity
            window = 0
        }
    }

    var done: Bool {
        // A voice onset straddling the deadline still gets the 60 ms activity check.
        if loudDuration > 0 && loudDuration < 0.06 && elapsed - loudDuration <= 6 { return false }
        guard let lastSound else { return elapsed >= 6 }
        // Continuous machinery can be loud without producing any words. Allow onset near
        // six seconds a short decoder delay; a recognized, continuing phrase has no time cap.
        if partial.isEmpty && elapsed >= decoderDeadline { return true }
        let trailing = partial.trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
        let unfinished = ["하고", "그리고", "이랑", "랑", "하고요"].contains { trailing.hasSuffix($0) }
        let silence = elapsed - lastSound
        return silence >= (unfinished ? 1.5 : 0.8) && (!partial.isEmpty || elapsed >= 6)
    }
}

struct AudioFrame {
    let inputs: [AnalyzerInput]
    let db: Double
    let seconds: Double

    init(buffer: AVAudioPCMBuffer, converter: AnalyzerInputConverter) throws {
        guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else {
            throw VoiceFailure("마이크에서 PCM 음성 데이터를 읽을 수 없습니다. Mac의 사운드 입력을 확인하세요.")
        }
        var rms: Float = 0
        vDSP_rmsqv(samples, vDSP_Stride(buffer.stride), &rms, vDSP_Length(buffer.frameLength))
        db = 20 * log10(max(0.00001, Double(rms)))
        seconds = Double(buffer.frameLength) / buffer.format.sampleRate
        inputs = try converter.convert(buffer, at: nil)
    }
}

// Keep the beginning of a near-end utterance while testing for sustained activity
// on the echo-cancelled microphone. A tap or a few echo samples cannot open a turn.
struct PlaybackGate {
    private var activity = Endpoint()
    private var recent: [AudioFrame] = []
    private var bufferedSeconds = 0.0
    private var forwarding = false
    private(set) var ducked = false

    mutating func frames(for frame: AudioFrame) -> [AudioFrame] {
        activity.frame(db: frame.db, seconds: frame.seconds)
        if activity.loudDuration >= 0.12 {
            ducked = true
        } else if activity.elapsed - (activity.lastSound ?? 0) >= 0.35 {
            ducked = false
        }
        if forwarding { return [frame] }
        recent.append(frame)
        bufferedSeconds += frame.seconds
        while bufferedSeconds - recent[0].seconds > 0.35 {
            bufferedSeconds -= recent.removeFirst().seconds
        }
        guard ducked else { return [] }
        forwarding = true
        return drain()
    }

    mutating func tailAtPlaybackEnd() -> [AudioFrame] {
        // Preserve a short word that began just before the last playback sample.
        return !forwarding && activity.loudDuration > 0 ? drain() : []
    }

    private mutating func drain() -> [AudioFrame] {
        defer { recent.removeAll(); bufferedSeconds = 0 }
        return recent
    }
}

@MainActor protocol TurnPlayback {
    func start(finished: @escaping () -> Void) throws
    func setDucked(_ ducked: Bool)
    func stop()
}

enum TurnEvent: String {
    case listening, interrupted
    case playbackStarted = "playback_started"
    case replyFinished = "reply_finished"
}

protocol TurnInput {
    func start(converter: AnalyzerInputConverter) throws -> AsyncThrowingStream<AudioFrame, Error>
    func stop()
}

final class Microphone: TurnInput {
    let engine = AVAudioEngine()
    private var installed = false

    func start(converter: AnalyzerInputConverter) throws -> AsyncThrowingStream<AudioFrame, Error> {
        let node = engine.inputNode
        let format = node.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw VoiceFailure("사용 가능한 마이크가 없습니다. 시스템 설정에서 사운드 입력을 확인하세요.")
        }
        let (frames, sink) = AsyncThrowingStream<AudioFrame, Error>.makeStream(bufferingPolicy: .bufferingNewest(128))
        try node.installAudioTap(onBus: 0, bufferSize: 1024, format: nil) { samplesBuffer, _ in
            let buffer = AVAudioPCMBuffer(copying: samplesBuffer)
            do {
                let result = sink.yield(try AudioFrame(buffer: buffer, converter: converter))
                if case .dropped = result { sink.finish(throwing: VoiceFailure("음성 입력이 지연되었습니다. 다시 호출하세요.")) }
            } catch { sink.finish(throwing: error) }
        }
        installed = true
        engine.prepare()
        try engine.start()
        return frames
    }

    func stop() {
        if installed {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
            installed = false
        }
    }
}

@MainActor
final class Recognition {
    private var endpoint = Endpoint()
    private var finalParts: [String] = []
    private var streamError: Error?
    private var lastFrame = ContinuousClock.now
    private var accepting = false
    private var receivedFrame = false
    private var turning = true
    private var playbackActive = false
    private var playbackGate = PlaybackGate()

    private var finalText: String {
        finalParts.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private let transcriber: SpeechTranscriber
    private let detector: SpeechDetector
    private let analyzer: SpeechAnalyzer
    private let converter: AnalyzerInputConverter

    init() async throws {
        let module = try await installedTranscriber()
        let vad = SpeechDetector(detectionOptions: .init(sensitivityLevel: .medium), reportResults: true)
        let modules: [any SpeechModule] = [vad, module]
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: modules) else {
            throw VoiceFailure("음성 입력 형식을 준비하지 못했습니다. Mac의 사운드 입력을 확인하세요.")
        }
        transcriber = module
        detector = vad
        analyzer = SpeechAnalyzer(modules: modules)
        converter = AnalyzerInputConverter(analyzerFormat: format) { conversion in
            // The Mac voice-processing input can expose nine channels. Transcribe the
            // processed microphone (channel zero), the same signal measured by AudioFrame.
            if conversion.inputFormat.channelCount > 1 && conversion.outputFormat.channelCount == 1 {
                conversion.channelMap = [0]
            }
        }
        try await analyzer.prepareToAnalyze(in: format)
    }

    func listen(input: TurnInput, cue: Bool, playback: TurnPlayback? = nil,
                notify: @escaping (TurnEvent) -> Void) async throws -> String {
        let (audio, sink) = AsyncStream<AnalyzerInput>.makeStream(bufferingPolicy: .bufferingNewest(128))
        defer { playback?.stop(); input.stop(); sink.finish() }
        playbackActive = playback != nil

        func feed(_ frame: AudioFrame) {
            for sample in frame.inputs {
                if case .dropped = sink.yield(sample) { streamError = VoiceFailure("음성 분석이 지연되었습니다. 다시 호출하세요.") }
            }
            endpoint.frame(db: frame.db, seconds: frame.seconds)
        }

        func followUp(interrupted: Bool) {
            guard playbackActive else { return }
            playbackActive = false
            if interrupted {
                playback?.stop()
            } else {
                // Start the six-second clock at audible completion. Carry recent near-end activity
                // across that boundary so speech spanning the last playback buffer is not cut off.
                let recent = endpoint.lastSound.map { endpoint.elapsed - $0 < 1.5 } ?? false
                endpoint = Endpoint()
                if recent { endpoint.lastSound = 0 }
                for frame in playbackGate.tailAtPlaybackEnd() { feed(frame) }
            }
            notify(interrupted ? .interrupted : .replyFinished)
        }
        let words = Task {
            do {
                for try await result in transcriber.results {
                    let text = String(result.text.characters)
                    if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && playbackActive {
                        followUp(interrupted: true)
                    }
                    if result.isFinal { finalParts.append(text) }
                    endpoint.recognized(text)
                }
            } catch { streamError = error }
        }
        let vad = Task {
            do { for try await _ in detector.results {} }
            catch { streamError = error }
        }
        var pump: Task<Void, Never>?
        defer { pump?.cancel(); words.cancel(); vad.cancel() }
        do {
            try await analyzer.start(inputSequence: audio)
            accepting = !cue && playback == nil
            let frames = try input.start(converter: converter)
            pump = Task {
                do {
                    for try await frame in frames {
                        lastFrame = .now
                        receivedFrame = true
                        guard accepting, turning else { continue }
                        if playbackActive {
                            let wasDucked = playbackGate.ducked
                            for sample in playbackGate.frames(for: frame) { feed(sample) }
                            if playbackGate.ducked != wasDucked { playback?.setDucked(playbackGate.ducked) }
                        } else {
                            feed(frame)
                            if endpoint.done { turning = false }
                        }
                    }
                } catch {
                    if !Task.isCancelled && turning { streamError = error }
                }
            }
            lastFrame = .now
            while !receivedFrame && streamError == nil {
                try await Task.sleep(for: .milliseconds(10))
                if lastFrame.duration(to: .now) > .seconds(3) { throw VoiceFailure("마이크에서 신호를 받지 못했습니다. 입력 장치를 확인하세요.") }
            }
            if let streamError { throw streamError }
            // Drop the cue's samples before opening the turn.
            if cue, let tone = NSSound(named: "Tink"), tone.play() {
                try await Task.sleep(for: .seconds(tone.duration))
            }
            accepting = true
            if let playback {
                try playback.start { followUp(interrupted: false) }
                notify(.playbackStarted)
            } else {
                notify(.listening)
            }
            while turning && streamError == nil {
                try await Task.sleep(for: .milliseconds(30))
                if lastFrame.duration(to: .now) > .seconds(3) {
                    throw VoiceFailure("마이크 입력이 중단되었습니다. 입력 장치를 확인한 뒤 다시 호출하세요.")
                }
            }
            if let streamError { throw streamError }
            input.stop()
            pump?.cancel()
            if endpoint.lastSound == nil && finalParts.isEmpty && endpoint.partial.isEmpty {
                sink.finish()
                await analyzer.cancelAndFinishNow()
                return ""
            }
            for tail in try converter.flush() { sink.yield(tail) }
            sink.finish()
            try await analyzer.finalizeAndFinishThroughEndOfInput()
            await words.value
            if let streamError { throw streamError }
            return finalText
        } catch {
            input.stop()
            sink.finish()
            await analyzer.cancelAndFinishNow()
            // The decoder can reject trailing silence after an earlier segment was finalized.
            // Keep those finals; a partial alone still cannot trigger a packing command.
            let failure = error as NSError
            if !playbackActive && failure.domain == "SFSpeechErrorDomain" && failure.code == 1 {
                await words.value
                return finalText
            }
            throw error
        }
    }
}
