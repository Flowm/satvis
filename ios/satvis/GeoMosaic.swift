import Foundation
import Observation
import SatvisRender
import os

nonisolated private let log = Logger(subsystem: "org.frcy.app.satvis", category: "imagery")

/// The geostationary mosaic's frame for the clock, while it is the base map (ADR 0022):
/// the latest Slot the collection lists at or before the clock, or its earliest before
/// them all, as the web app's `snapToFrame` picks it.
@MainActor
@Observable
final class GeoMosaic {
    /// The frame handed to the globe, nil while none is.
    private(set) var drawn: MosaicFrame?
    /// Each Slot, epoch milliseconds, to its item; nil until the collection is read.
    @ObservationIgnored private var slots: [Double: URL]?
    @ObservationIgnored private var listed = Date.distantPast
    @ObservationIgnored private var isListing = false
    @ObservationIgnored private var frames: [URL: Frame] = [:]
    /// The items of `frames`, the least lately asked for first.
    @ObservationIgnored private var asked: [URL] = []

    private enum Frame {
        case opening
        case ready(MosaicFrame)
        case failed(at: Date)
    }

    /// How soon a collection or file that could not be read is asked for again.
    private static let retry: TimeInterval = 60
    /// How often the collection is read again once the clock is past its last Slot:
    /// a Slot is published within the hour after it.
    private static let refresh: TimeInterval = 10 * 60
    /// Frames kept opened, for a clock going back and forth.
    private static let kept = 6

    /// The attribution the drawn frame asks for, a line a satellite.
    var credit: [String] { drawn?.credit ?? [] }

    /// Keeps `apply` handed the frame for `now` while `shown`, nil otherwise, once a
    /// second, until cancelled. A frame still opening leaves the last one drawn.
    /// `read` fetches a span of a file.
    func follow(
        shown: @escaping @MainActor () -> Bool, now: @escaping @MainActor () -> Double,
        read: @escaping @Sendable (URL, ClosedRange<Int>) async throws -> Data, apply: @escaping @MainActor (MosaicFrame?) -> Void
    ) async {
        while !Task.isCancelled {
            let isShown = shown()
            let wanted = isShown ? frame(at: now(), read: read) : nil
            if isShown ? wanted.map { $0 != drawn } ?? false : drawn != nil {
                drawn = wanted
                apply(drawn)
            }
            try? await Task.sleep(for: .seconds(1))
        }
    }

    /// The frame for `time` once opened, asking for the collection and opening the file
    /// when they are due.
    private func frame(at time: Double, read: @escaping @Sendable (URL, ClosedRange<Int>) async throws -> Data) -> MosaicFrame? {
        let since = Date().timeIntervalSince(listed)
        let due = slots == nil ? since >= Self.retry : time > (slots?.keys.max() ?? 0) && since >= Self.refresh
        if !isListing, due {
            isListing = true
            listed = Date()
            Task {
                if let read = await Self.list() {
                    slots = read
                } else {
                    log.error("Could not read the geostationary mosaic's collection")
                }
                isListing = false
            }
        }
        guard let slots, let slot = slots.keys.filter({ $0 <= time }).max() ?? slots.keys.min(), let item = slots[slot] else {
            return nil
        }
        if asked.last != item {
            asked.removeAll { $0 == item }
            asked.append(item)
        }
        switch frames[item] {
        case .ready(let frame):
            return frame
        case .opening:
            return nil
        case .failed(let at) where Date().timeIntervalSince(at) < Self.retry:
            return nil
        default:
            break
        }
        frames[item] = .opening
        forgetOldest(keeping: item)
        Task {
            let opened: Frame
            do {
                let (data, response) = try await URLSession.shared.data(from: item)
                guard (response as? HTTPURLResponse)?.statusCode == 200, let file = Mosaic.file(item: data, at: item) else {
                    throw URLError(.cannotParseResponse)
                }
                opened = .ready(try await Mosaic.open(file.url, credit: file.credit) { try await read(file.url, $0) })
            } catch {
                log.error("\(item, privacy: .public): \(error, privacy: .public)")
                opened = .failed(at: Date())
            }
            // Forgotten while it opened.
            if case .opening = frames[item] {
                frames[item] = opened
            }
        }
        return nil
    }

    /// Past `kept`, forgets the frame least lately asked for, but never `item`'s or the
    /// drawn one.
    private func forgetOldest(keeping item: URL) {
        guard frames.count > Self.kept,
            let oldest = asked.first(where: { key in
                if case .ready(let frame) = frames[key] { frame != drawn } else { key != item }
            })
        else {
            return
        }
        frames[oldest] = nil
        asked.removeAll { $0 == oldest }
    }

    /// The collection's Slots; nil when it cannot be read.
    nonisolated private static func list() async -> [Double: URL]? {
        guard let (data, response) = try? await URLSession.shared.data(from: Mosaic.collection), (response as? HTTPURLResponse)?.statusCode == 200,
            let slots = Mosaic.slots(collection: data, at: Mosaic.collection), !slots.isEmpty
        else {
            return nil
        }
        return slots
    }
}
