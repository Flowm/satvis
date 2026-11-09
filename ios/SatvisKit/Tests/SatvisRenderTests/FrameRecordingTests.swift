import Testing

@testable import SatvisRender

@Suite struct FrameRecordingTests {
    // Ninety frames on the 60 Hz pace and ten that missed it twice over: what
    // the benchmark reads off one test case.
    @Test func summarisesAnUnevenRecording() throws {
        let recording = FrameRecording(
            intervals: Array(repeating: 16.7, count: 90) + Array(repeating: 50.1, count: 10), cpu: [1, 3], bufferWait: [0, 2], drawableWait: [4, 12], gpu: [8, 10])
        #expect(abs(try #require(recording.framesPerSecond) - 100 / 2.004) < 1e-6)
        #expect(FrameRecording.percentile(recording.intervals, 0.5) == 16.7)
        #expect(FrameRecording.percentile(recording.intervals, 0.95) == 50.1)
        #expect(FrameRecording.percentile(recording.intervals, 0) == 16.7)
        #expect(FrameRecording.overBudget(cpu: [4, 20, 4, 4], gpu: [], budget: 1000.0 / 60) == 25)
        #expect(FrameRecording.overBudget(cpu: [4, 4], gpu: [20, 4, 4, 4, 4], budget: 1000.0 / 60) == 20)
        #expect(recording.meanCPU == 2)
        #expect(recording.meanBufferWait == 1)
        #expect(recording.meanDrawableWait == 8)
        #expect(recording.meanGPU == 9)
    }

    @Test func readsNothingFromNoFrames() {
        let recording = FrameRecording()
        #expect(
            recording.framesPerSecond == nil && FrameRecording.percentile(recording.cpu, 0.95) == nil
                && FrameRecording.overBudget(cpu: recording.cpu, gpu: recording.gpu, budget: 1000.0 / 60) == nil && recording.meanBufferWait == nil
                && recording.meanDrawableWait == nil
                && recording.meanGPU == nil)
    }

    // Frames handed to the meter while it records come back, each GPU time with
    // them, and the meter stops keeping them once the recording is taken.
    @Test func recordsFramesWhileAsked() throws {
        let meter = FrameMeter()
        meter.startRecording(at: 0)
        for frame in 0..<4 {
            meter.frame(cpuSeconds: 0.002, bufferWaitSeconds: 0.001, drawableWaitSeconds: 0.012, at: Double(frame) / 60, satellites: 10, id: frame)
            meter.gpu(start: Double(frame) / 60, end: Double(frame) / 60 + 0.008, frame: frame)
            meter.skipped(cpuSeconds: 0.0005)
        }
        let recording = meter.stopRecording(at: 0.25)
        #expect(recording.intervals.count == 3 && recording.cpu.count == 4 && recording.bufferWait.count == 4 && recording.drawableWait.count == 4 && recording.gpu.count == 4)
        #expect(recording.skippedCPU == [0.5, 0.5, 0.5, 0.5] && recording.duration == 250)
        #expect(abs(try #require(recording.gpuActive) - 32) < 1e-9)
        #expect(abs(recording.intervals[0] - 1000.0 / 60) < 1e-9)
        meter.frame(cpuSeconds: 0.002, bufferWaitSeconds: 0, drawableWaitSeconds: 0, at: 1, satellites: 10, id: 4)
        #expect(meter.stopRecording(at: 1) == FrameRecording())
    }

    // Busy is the time each side spent over the time recorded, the CPU's with the
    // calls that drew nothing; load is the busier side's, the CPU's here.
    @Test func measuresTheLoadOfTheBusierSide() throws {
        let recording = FrameRecording(intervals: [100, 100], cpu: [30, 30, 20], gpu: [5, 5, 5], skippedCPU: [10, 10], duration: 500, gpuActive: 15)
        #expect(abs(try #require(recording.cpuBusy) - 20) < 1e-9)
        #expect(abs(try #require(recording.gpuBusy) - 3) < 1e-9)
        #expect(recording.load == recording.cpuBusy)
        // The simulator's GPU reads nothing, which leaves load unknown.
        #expect(FrameRecording(cpu: [10], duration: 100).cpuBusy == 10)
        #expect(FrameRecording(cpu: [10], duration: 100).load == nil)
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
        for (frame, start) in [0.0, 0.011, 0.022].enumerated() {
            meter.gpu(start: start, end: start + 0.017, frame: frame)
        }
        let recording = meter.stopRecording(at: 0.04)
        #expect(abs(try #require(recording.gpuActive) - 39) < 1e-9)
        #expect(abs(try #require(recording.gpuBusy) - 97.5) < 1e-9)
        #expect(abs(try #require(recording.meanGPU) - 17) < 1e-9)
    }

    // The panel's half-second figures: the CPU's busy time with the calls that drew
    // nothing, the GPU's from its spans; and the graph's frames, each with its GPU time.
    @Test func publishesTheBusyTimesAndKeepsTheGraphsFrames() throws {
        let meter = FrameMeter()
        for frame in 0..<40 {
            let at = Double(frame) / 60
            meter.frame(cpuSeconds: 0.004, bufferWaitSeconds: 0, drawableWaitSeconds: 0, at: at, satellites: 5, id: frame)
            meter.gpu(start: at, end: at + 0.008, frame: frame)
            meter.skipped(cpuSeconds: 0.001)
        }
        let stats = try #require(meter.stats)
        #expect(abs(stats.cpuBusy - 30) < 2.5)
        #expect(abs(try #require(stats.gpuBusy) - 48) < 2.5)
        #expect(stats.load == stats.gpuBusy)
        let frames = meter.recentFrames
        #expect(frames.count == 40)
        #expect(frames.allSatisfy { $0.gpu.map { abs($0 - 8) < 1e-9 } == true })
    }

    // A frame without a GPU time shifted every later one onto the frame before.
    @Test func matchesEachGPUTimeToItsFrame() {
        let meter = FrameMeter()
        meter.gpu(start: 0, end: 0.003, frame: 1)
        for id in 1...3 {
            meter.frame(cpuSeconds: 0.004, bufferWaitSeconds: 0, drawableWaitSeconds: 0, at: Double(id) / 60, satellites: 5, id: id)
        }
        meter.gpu(start: 1, end: 1, frame: 2)
        meter.gpu(start: 2, end: 2.005, frame: 3)
        let gpu = meter.recentFrames.map(\.gpu)
        #expect(gpu.count == 3 && gpu[1] == nil)
        #expect(abs((gpu[0] ?? 0) - 3) < 1e-6 && abs((gpu[2] ?? 0) - 5) < 1e-6)
    }
}
