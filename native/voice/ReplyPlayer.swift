import AVFoundation
import Foundation

/// Render the reply through the microphone's VoiceProcessingIO graph. The far-end
/// reference for echo cancellation must contain the actual samples sent to the speaker.
@MainActor
final class ReplyPlayer: TurnPlayback {
    private let player = AVAudioPlayerNode()
    private let buffers: [AVAudioPCMBuffer]
    private var completion: (() -> Void)?

    init(utterance: AVSpeechUtterance, engine: AVAudioEngine) async throws {
        let synth = AVSpeechSynthesizer()
        let (samples, output) = AsyncStream<AVAudioPCMBuffer>.makeStream()
        synth.write(utterance) { audio in
            guard let pcm = audio as? AVAudioPCMBuffer, pcm.frameLength > 0 else {
                output.finish()
                return
            }
            output.yield(AVAudioPCMBuffer(copying: pcm))
        }
        var rendered: [AVAudioPCMBuffer] = []
        for await pcm in samples { rendered.append(pcm) }
        withExtendedLifetime(synth) {}
        guard let format = rendered.first?.format else { throw VoiceFailure("Yuna 음성을 생성하지 못했습니다.") }
        buffers = rendered
        try engine.inputNode.setVoiceProcessingEnabled(true)
        engine.attach(player)
        try engine.connectNode(player, to: engine.mainMixerNode, format: format)
        // VoiceProcessingIO needs matching input and render rates. The default mixer
        // connection can negotiate 44.1 kHz while the Mac microphone is running at 48 kHz.
        let rate = engine.inputNode.outputFormat(forBus: 0).sampleRate
        guard rate > 0, let renderFormat = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1) else {
            throw VoiceFailure("에코 제거에 사용할 마이크·스피커 형식을 확인하세요.")
        }
        try engine.connectNode(engine.mainMixerNode, to: engine.outputNode, format: renderFormat)
    }

    func start(finished: @escaping () -> Void) throws {
        completion = finished
        for buffer in buffers.dropLast() { player.scheduleBuffer(buffer) }
        player.scheduleBuffer(buffers[buffers.count - 1], completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in
                let notify = self?.completion
                self?.completion = nil
                notify?()
            }
        }
        try player.playAudio()
    }

    func setDucked(_ ducked: Bool) {
        player.volume = ducked ? 0.22 : 1
    }

    func stop() {
        completion = nil
        player.stop()
    }
}
