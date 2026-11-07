// Native integration test: replay a Yuna recording and silence at microphone speed.
import AVFoundation
import Foundation
import Speech

final class RecordedInput: TurnInput {
    let url: URL
    var producer: Task<Void, Never>?

    let silenceOnly: Bool
    let leadIn: Double

    init(_ url: URL, silenceOnly: Bool = false, leadIn: Double = 0) {
        self.url = url
        self.silenceOnly = silenceOnly
        self.leadIn = leadIn
    }

    func start(converter: AnalyzerInputConverter) throws -> AsyncThrowingStream<AudioFrame, Error> {
        let file = try AVAudioFile(forReading: url)
        let format = file.processingFormat
        let (stream, sink) = AsyncThrowingStream<AudioFrame, Error>.makeStream()
        producer = Task {
            do {
                var silentFrames = 0
                while !Task.isCancelled {
                    let length: AVAudioFrameCount = 1024
                    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: length)!
                    if !silenceOnly && Double(silentFrames) / format.sampleRate >= leadIn && file.framePosition < file.length {
                        try file.read(into: buffer, frameCount: length)
                    } else {
                        buffer.frameLength = length
                        for channel in 0..<Int(format.channelCount) {
                            buffer.floatChannelData![channel].update(repeating: 0, count: Int(length))
                        }
                        silentFrames += Int(length)
                        if Double(silentFrames) / format.sampleRate > 20 { throw VoiceFailure("Turn failed to close") }
                    }
                    let frame = try AudioFrame(buffer: buffer, converter: converter)
                    sink.yield(frame)
                    try await Task.sleep(for: .seconds(frame.seconds))
                }
                sink.finish()
            } catch { sink.finish(throwing: error) }
        }
        return stream
    }

    func stop() { producer?.cancel() }
}

@MainActor final class TimedPlayback: TurnPlayback {
    let duration: Duration
    private var timer: Task<Void, Never>?
    private(set) var playedToEnd = false
    private(set) var ducking: [Bool] = []

    init(duration: Duration) { self.duration = duration }

    func start(finished: @escaping () -> Void) {
        timer = Task {
            do { try await Task.sleep(for: duration) } catch { return }
            playedToEnd = true
            finished()
        }
    }

    func setDucked(_ ducked: Bool) { ducking.append(ducked) }
    func stop() { timer?.cancel() }
}

@main struct VoiceTurnTests {
    @MainActor static func main() async throws {
        func after(_ speech: String, silence: Double) -> Bool {
            var turn = Endpoint()
            turn.frame(db: -22, seconds: 0.2)
            turn.partial = speech
            turn.frame(db: -90, seconds: silence)
            return turn.done
        }
        precondition(!after("재고 알려줘", silence: 0.75) && after("재고 알려줘", silence: 0.85))
        precondition(!after("생수하고…", silence: 1.1) && after("생수하고…", silence: 1.55))
        var late = Endpoint()
        late.frame(db: -90, seconds: 5.88)
        late.frame(db: -22, seconds: 0.15)
        precondition(!late.done)
        var boundary = Endpoint()
        boundary.frame(db: -90, seconds: 5.98)
        boundary.frame(db: -22, seconds: 0.03)
        precondition(!boundary.done)
        var fan = Endpoint()
        for _ in 0..<60 { fan.frame(db: -36, seconds: 0.02) }
        fan.frame(db: -16, seconds: 0.16)
        fan.recognized("재고 알려줘")
        for _ in 0..<60 { fan.frame(db: -36, seconds: 0.02) }
        precondition(fan.done)
        var silence = Endpoint()
        silence.frame(db: -90, seconds: 6.05)
        precondition(silence.done)
        let file = URL(fileURLWithPath: CommandLine.arguments[1])
        let result = try await Recognition().listen(input: RecordedInput(file), cue: false, notify: { _ in })
        guard result.contains("재고") && result.contains("알려") else {
            throw VoiceFailure("Expected 재고 알려줘, got: " + result)
        }
        let timeout = try await Recognition().listen(input: RecordedInput(file, silenceOnly: true), cue: false, notify: { _ in })
        precondition(timeout.isEmpty)
        var handoffs: [TurnEvent] = []
        let longReply = TimedPlayback(duration: .seconds(10))
        let orderFile = CommandLine.arguments.dropFirst(2).first.map { URL(fileURLWithPath: $0) }
        let interruptInput = RecordedInput(orderFile ?? file, leadIn: 1)
        let interruption = try await Recognition().listen(input: interruptInput, cue: false, playback: longReply) {
            handoffs.append($0)
        }
        precondition(handoffs == [.playbackStarted, .interrupted] && !longReply.playedToEnd && longReply.ducking.first == true)
        precondition(interruption.contains(orderFile == nil ? "재고" : "주문") && interruption.contains("알려"), interruption)

        handoffs = []
        let quietReply = TimedPlayback(duration: .seconds(7))
        let start = ContinuousClock.now
        let quiet = try await Recognition().listen(input: RecordedInput(file, silenceOnly: true), cue: false,
                                                  playback: quietReply) { handoffs.append($0) }
        precondition(quiet.isEmpty && handoffs == [.playbackStarted, .replyFinished] && quietReply.playedToEnd && quietReply.ducking.isEmpty)
        precondition(start.duration(to: .now) >= .seconds(13))
        print("Verified Korean transcription, interruption during playback, and timeout after playback:", result, interruption)
    }
}
