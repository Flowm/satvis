import Foundation
import Metal
import os

private let log = Logger(subsystem: "org.frcy.app.satvis", category: "gpu")

/// A frame the GPU failed: Metal's `MTLCommandBufferError` code, and how many
/// frames have failed since the renderer was made.
public struct GPUFault: Sendable, Equatable {
    public var code: Int
    /// `MTLCommandBufferError.Code`'s name, as the log and analytics read it.
    public var name: String
    public var description: String
    public var count: Int
}

/// Counts the frames the GPU failed and reports each kind of failure once. After
/// a timeout or a fault iOS refuses the process's later command buffers
/// ("Ignored (for causing prior/excessive GPU errors)"), so one failure is
/// followed by one a frame.
final class GPUFaults: @unchecked Sendable {
    private let lock = OSAllocatedUnfairLock(initialState: State())
    /// Called on the main actor with the first failure of each code.
    nonisolated(unsafe) var onFault: (@MainActor @Sendable (GPUFault) -> Void)?

    private struct State {
        var count = 0
        var reported: Set<Int> = []
    }

    /// From a command buffer's completed handler, on Metal's thread.
    func record(_ error: (any Error)?) {
        let nsError = error as NSError?
        let code = nsError?.code ?? -1
        let (count, first) = lock.withLock { state in
            state.count += 1
            return (state.count, state.reported.insert(code).inserted)
        }
        let fault = GPUFault(code: code, name: Self.name(of: code), description: nsError?.localizedDescription ?? "no error", count: count)
        if first {
            log.error("Frame failed on the GPU: \(fault.name, privacy: .public) (\(code)): \(fault.description, privacy: .public)")
            let onFault = onFault
            Task { @MainActor in onFault?(fault) }
        } else if count.isMultiple(of: 600) {
            log.error("\(count) frames failed on the GPU, the last \(fault.name, privacy: .public)")
        }
    }

    static func name(of code: Int) -> String {
        switch MTLCommandBufferError.Code(rawValue: UInt(max(code, 0))) {
        case .timeout: "timeout"
        case .pageFault: "pageFault"
        case .accessRevoked: "accessRevoked"
        case .notPermitted: "notPermitted"
        case .outOfMemory: "outOfMemory"
        case .invalidResource: "invalidResource"
        case .memoryless: "memoryless"
        case .deviceRemoved: "deviceRemoved"
        case .stackOverflow: "stackOverflow"
        case .internal: "internal"
        default: "code\(code)"
        }
    }
}
