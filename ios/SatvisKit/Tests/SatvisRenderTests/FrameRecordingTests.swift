import Testing

@testable import SatvisRender

@Suite struct FrameRecordingTests {
    // Ninety frames on the 60 Hz pace and ten that missed it twice over: what
    // the benchmark reads off one test case.
    @Test func summarisesAnUnevenRecording() throws {
        let recording = FrameRecording(
            intervals: Array(repeating: 16.7, count: 90) + Array(repeating: 50.1, count: 10), cpu: [1, 3], bufferWait: [0, 2], drawableWait: [4, 12], gpu: [8, 10])
        #expect(abs(try #require(recording.framesPerSecond) - 100 / 2.004) < 1e-6)
        #expect(recording.percentile(0.5) == 16.7)
        #expect(recording.percentile(0.95) == 50.1)
        #expect(recording.percentile(0) == 16.7)
        #expect(recording.slowShare(refresh: 1000.0 / 60) == 0.1)
        #expect(FrameRecording(intervals: [16.7, 32.5]).slowShare(refresh: 1000.0 / 60) == 0.5)
        #expect(recording.meanCPU == 2)
        #expect(recording.meanBufferWait == 1)
        #expect(recording.meanDrawableWait == 8)
        #expect(recording.meanGPU == 9)
    }

    @Test func readsNothingFromNoFrames() {
        let recording = FrameRecording()
        #expect(
            recording.framesPerSecond == nil && recording.percentile(0.95) == nil && recording.slowShare(refresh: 1000.0 / 60) == nil && recording.meanBufferWait == nil
                && recording.meanDrawableWait == nil
                && recording.meanGPU == nil)
    }

    // Frames handed to the meter while it records come back, each GPU time with
    // them, and the meter stops keeping them once the recording is taken.
    @Test func recordsFramesWhileAsked() throws {
        let meter = FrameMeter()
        meter.startRecording(at: 0)
        for frame in 0..<4 {
            meter.frame(cpuSeconds: 0.002, bufferWaitSeconds: 0.001, drawableWaitSeconds: 0.012, at: Double(frame) / 60, satellites: 10)
            meter.gpu(start: Double(frame) / 60, end: Double(frame) / 60 + 0.008)
            meter.skipped(cpuSeconds: 0.0005)
        }
        let recording = meter.stopRecording(at: 0.25)
        #expect(recording.intervals.count == 3 && recording.cpu.count == 4 && recording.bufferWait.count == 4 && recording.drawableWait.count == 4 && recording.gpu.count == 4)
        #expect(recording.skippedCPU == [0.5, 0.5, 0.5, 0.5] && recording.duration == 250)
        #expect(abs(try #require(recording.gpuActive) - 32) < 1e-9)
        #expect(abs(recording.intervals[0] - 1000.0 / 60) < 1e-9)
        meter.frame(cpuSeconds: 0.002, bufferWaitSeconds: 0, drawableWaitSeconds: 0, at: 1, satellites: 10)
        #expect(meter.stopRecording(at: 1) == FrameRecording())
    }

    // Busy is the time each side spent over the time recorded, the CPU's with the
    // calls that drew nothing; load is the busier side's, the CPU's here.
    @Test func measuresTheLoadOfTheBusierSide() throws {
        let recording = FrameRecording(intervals: [100, 100], cpu: [30, 30, 20], gpu: [5, 5, 5], skippedCPU: [10, 10], duration: 500, gpuActive: 15)
        #expect(abs(try #require(recording.cpuBusy) - 20) < 1e-9)
        #expect(abs(try #require(recording.gpuBusy) - 3) < 1e-9)
        #expect(recording.load == recording.cpuBusy)
        // The simulator's GPU reads nothing, which leaves the CPU's.
        #expect(FrameRecording(cpu: [10], duration: 100).load == 10)
        #expect(FrameRecording(cpu: [10]).load == nil)
    }

    // Spans of 17 ms every 11 cover 39 ms, not 51.
    @Test func joinsOverlappingSpans() {
        var spans = GPUSpans()
        let covered = [0.0, 0.011, 0.022].map { spans.join(start: $0, end: $0 + 0.017) }
        #expect(abs(covered.reduce(0, +) - 0.039) < 1e-12 && spans.end == 0.039)
    }

    // A frame's vertices run on the GPU under the last frame's fragments: spans
    // of 17 ms every 11 keep it busy 39 ms of the 40, not 51.
    @Test func joinsOverlappingGPUSpans() throws {
        let meter = FrameMeter()
        meter.startRecording(at: 0)
        for start in [0.0, 0.011, 0.022] {
            meter.gpu(start: start, end: start + 0.017)
        }
        let recording = meter.stopRecording(at: 0.04)
        #expect(abs(try #require(recording.gpuActive) - 39) < 1e-9)
        #expect(abs(try #require(recording.gpuBusy) - 97.5) < 1e-9)
        #expect(abs(try #require(recording.meanGPU) - 17) < 1e-9)
    }
}
