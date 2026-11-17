import AVFoundation
import Foundation

private func finish(_ message: String, code: Int32) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

private func microphoneAllowed() -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        return true
    case .denied, .restricted:
        return false
    case .notDetermined:
        let semaphore = DispatchSemaphore(value: 0)
        var allowed = false
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            allowed = granted
            semaphore.signal()
        }
        semaphore.wait()
        return allowed
    @unknown default:
        return false
    }
}

let arguments = CommandLine.arguments
if arguments.count != 3 {
    finish("usage: TailchatVoiceRecorder <output.wav> <seconds>", code: 64)
}

let output = URL(fileURLWithPath: arguments[1])
// Five minutes: the ceiling `/voice` documents and `recordAudio` clamps to.
// This guard said 60, so on a Mac — where this native recorder is the default
// backend — every longer note exited 64 with a usage error instead of being
// recorded, whatever the two clamps in front of it allowed.
guard let duration = Double(arguments[2]), duration > 0, duration <= 300 else {
    finish("duration must be between 1 and 300 seconds", code: 64)
}

guard microphoneAllowed() else {
    finish("microphone permission denied", code: 77)
}

let settings: [String: Any] = [
    AVFormatIDKey: Int(kAudioFormatLinearPCM),
    AVSampleRateKey: 16_000.0,
    AVNumberOfChannelsKey: 1,
    AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsBigEndianKey: false,
    AVLinearPCMIsFloatKey: false,
]

do {
    let recorder = try AVAudioRecorder(url: output, settings: settings)
    guard recorder.prepareToRecord() else {
        finish("microphone recorder could not prepare", code: 74)
    }
    guard recorder.record(forDuration: duration) else {
        finish("microphone recorder could not start", code: 74)
    }
    // `/voice` can be finished early (see `recordAudio`'s `onStart`), and it
    // asks for that with SIGINT. The default handler would kill the process
    // with the WAV header still claiming zero frames, so the signal is taken
    // over here: stop the recorder, which writes the real header, then exit
    // cleanly so the caller treats it as a finished recording.
    signal(SIGINT, SIG_IGN)
    let stopSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    stopSource.setEventHandler {
        recorder.stop()
        exit(0)
    }
    stopSource.resume()
    RunLoop.current.run(until: Date(timeIntervalSinceNow: duration + 0.2))
    recorder.stop()
} catch {
    finish("microphone recording failed: \(error.localizedDescription)", code: 74)
}

exit(0)
