import AVFoundation
import Foundation
import Speech

struct Command: Decodable {
    let action: String
    let session: String
    let turn: Int
    let text: String?

    func event(_ event: String, text: String = "") throws {
        let data = try JSONSerialization.data(withJSONObject: ["session": session, "turn": turn, "event": event, "text": text])
        try FileHandle.standardOutput.write(contentsOf: data + Data([10]))
    }
}

@MainActor
final class Speaker: NSObject, AVSpeechSynthesizerDelegate {
    let synthesizer = AVSpeechSynthesizer()
    private var finished: CheckedContinuation<Void, Never>?

    static func utterance(_ text: String) throws -> AVSpeechUtterance {
        guard let voice = AVSpeechSynthesisVoice.speechVoices().first(where: {
            $0.language == "ko-KR" && $0.name == "Yuna"
        }) else { throw VoiceFailure("시스템 설정 → 손쉬운 사용의 말하기 음성에서 한국어 Yuna를 설치하세요.") }
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice
        return utterance
    }

    func speak(_ text: String) async throws {
        let utterance = try Self.utterance(text)
        synthesizer.delegate = self
        await withCheckedContinuation { continuation in
            finished = continuation
            synthesizer.speak(utterance)
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in finished?.resume(); finished = nil }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in finished?.resume(); finished = nil }
    }
}

@main struct Worker {
    @MainActor static func main() async {
        do { try await run() }
        catch {
            FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
            exit(1)
        }
    }

    @MainActor static func run() async throws {
        if CommandLine.arguments.dropFirst().first == "--install-ko" {
            let module = try await koreanTranscriber()
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
                try await request.downloadAndInstall()
            }
            _ = try await installedTranscriber()
            print("한국어 음성 모델을 사용할 수 있습니다.")
            return
        }
        if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--transcribe-file" {
            let transcriber = try await installedTranscriber()
            let analyzer = SpeechAnalyzer(modules: [SpeechDetector(), transcriber])
            let file = try AVAudioFile(forReading: URL(fileURLWithPath: CommandLine.arguments[2]))
            let words = Task {
                for try await result in transcriber.results where result.isFinal { print(String(result.text.characters)) }
            }
            try await analyzer.start(inputAudioFile: file, finishAfterFile: true)
            try await words.value
            return
        }
        let speaker = Speaker()
        let (commands, input) = AsyncStream<Command>.makeStream()
        DispatchQueue.global().async {
            while let line = readLine() {
                guard let command = try? JSONDecoder().decode(Command.self, from: Data(line.utf8)) else { exit(2) }
                input.yield(command)
            }
            // Parent shutdown must also release Core Audio during permission prompts or long utterances.
            exit(0)
        }
        var nextTurn: Task<Recognition, Error>?
        for await command in commands {
            var active = command
            do {
                switch command.action {
                case "listen":
                    if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
                        try command.event("permission")
                    }
                    guard await AVCaptureDevice.requestAccess(for: .audio) else {
                        throw VoiceFailure("시스템 설정 → 개인정보 보호 및 보안 → 마이크에서 서버를 실행한 앱의 접근을 허용하세요.")
                    }
                    let listener: Recognition
                    if command.turn > 1, let prepared = nextTurn {
                        listener = try await prepared.value
                    } else {
                        listener = try await Recognition()
                    }
                    nextTurn = nil
                    let result = try await listener.listen(input: Microphone(), cue: command.turn == 1) { event in
                        try? command.event(event.rawValue)
                    }
                    try command.event(result.isEmpty ? "timeout" : "final", text: result)
                case "speak_listen":
                    let mic = Microphone()
                    let listener = try await Recognition()
                    let player = try await ReplyPlayer(utterance: Speaker.utterance(command.text ?? ""), engine: mic.engine)
                    let result = try await listener.listen(input: mic, cue: false, playback: player) { event in
                        try? command.event(event.rawValue)
                        if event == .interrupted || event == .replyFinished {
                            active = Command(action: "listen", session: command.session, turn: command.turn + 1, text: nil)
                        }
                    }
                    try active.event(result.isEmpty ? "timeout" : "final", text: result)
                case "speak":
                    // Prepare recognition during playback; open the microphone only after playback completes.
                    nextTurn = Task { try await Recognition() }
                    try await speaker.speak(command.text ?? "")
                    try command.event("spoken")
                default:
                    throw VoiceFailure("알 수 없는 음성 요청입니다.")
                }
            } catch {
                nextTurn?.cancel()
                nextTurn = nil
                try active.event("error", text: error.localizedDescription)
            }
        }
    }
}
