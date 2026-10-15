import Foundation
import Metal
import Testing

@testable import SatvisRender

@Suite struct GPUFaultsTests {
    // After a timeout iOS refuses every later frame: reported once a kind, counted throughout.
    @Test @MainActor func reportsEachKindOnce() async {
        let faults = GPUFaults()
        var reported: [GPUFault] = []
        faults.onFault = { reported.append($0) }
        faults.record(NSError(domain: MTLCommandBufferErrorDomain, code: Int(MTLCommandBufferError.Code.timeout.rawValue)))
        for _ in 0..<5 {
            faults.record(NSError(domain: MTLCommandBufferErrorDomain, code: Int(MTLCommandBufferError.Code.accessRevoked.rawValue)))
        }
        while reported.count < 2 {
            await Task.yield()
        }
        #expect(reported.map(\.name) == ["timeout", "accessRevoked"])
        #expect(reported.map(\.count) == [1, 2])
    }
}
