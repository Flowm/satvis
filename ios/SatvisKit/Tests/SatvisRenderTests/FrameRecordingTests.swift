import Testing

@testable import SatvisRender

@Suite struct FrameRecordingTests {
    // Ninety frames on the 60 Hz pace and ten that missed it twice over: what
    // the benchmark reads off one test case.
    @Test func summarisesAnUnevenRecording() throws {
        let recording = FrameRecording(
            intervals: Array(repeating: 16.7, count: 90) + Array(repeating: 50.1, count: 10), cpu: [1, 3], gpu: [8, 10])
        #expect(abs(try #require(recording.framesPerSecond) - 100 / 2.004) < 1e-6)
        #expect(recording.percentile(0.5) == 16.7)
        #expect(recording.percentile(0.95) == 50.1)
        #expect(recording.percentile(0) == 16.7)
        #expect(recording.slowShare == 0.1)
        #expect(recording.meanCPU == 2)
        #expect(recording.meanGPU == 9)
    }

    @Test func readsNothingFromNoFrames() {
        let recording = FrameRecording()
        #expect(recording.framesPerSecond == nil && recording.percentile(0.95) == nil && recording.slowShare == nil && recording.meanGPU == nil)
    }

    // Frames handed to the meter while it records come back, each GPU time with
    // them, and the meter stops keeping them once the recording is taken.
    @Test func recordsFramesWhileAsked() {
        let meter = FrameMeter()
        meter.startRecording()
        for frame in 0..<4 {
            meter.frame(cpuSeconds: 0.002, at: Double(frame) / 60, satellites: 10)
            meter.gpu(seconds: 0.008)
        }
        let recording = meter.stopRecording()
        #expect(recording.intervals.count == 3 && recording.cpu.count == 4 && recording.gpu.count == 4)
        #expect(abs(recording.intervals[0] - 1000.0 / 60) < 1e-9)
        meter.frame(cpuSeconds: 0.002, at: 1, satellites: 10)
        #expect(meter.stopRecording() == FrameRecording())
    }
}
