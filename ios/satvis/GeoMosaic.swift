import CoreGraphics
import Foundation
import Observation
import SatvisCore
import SatvisRender
import os

nonisolated private let log = Logger(subsystem: "org.frcy.app.satvis", category: "imagery")

/// The geostationary mosaic's frames (ADR 0022), as instrument imagery draws them: the
/// latest Slot the collection lists at or before the clock, or its earliest before them
/// all, as the web app's `snapToFrame` picks it, and the newest Slot for the Imagery
/// tab's picture, the web app's `GeoMosaicImagery.ts`.
@MainActor
@Observable
final class GeoMosaic {
    /// What fetches a span of a file.
    typealias Read = @Sendable (URL, ClosedRange<Int>) async throws -> Data

    /// The frame last handed to the globe, nil while none is.
    private(set) var drawn: MosaicFrame?
    /// Fetches a span of a file.
    @ObservationIgnored private let read: Read
    /// Each Slot, epoch milliseconds, to its item; nil until the collection is read.
    @ObservationIgnored private var slots: [Double: URL]?
    @ObservationIgnored private var listed = Date.distantPast
    @ObservationIgnored private var isListing = false
    @ObservationIgnored private var frames: [URL: Frame] = [:]
    /// The items of `frames`, the least lately asked for first.
    @ObservationIgnored private var asked: [URL] = []
    /// The newest Slot's file as last opened for a picture, and until when it is the newest.
    @ObservationIgnored private var newestFrame: (until: Date, frame: Task<MosaicFrame, any Error>)?

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

    init(read: @escaping Read) {
        self.read = read
    }

    /// The attribution the drawn frame asks for, a line a satellite.
    var credit: [String] { drawn?.credit ?? [] }

    /// The frame for `time`, or while it opens the one drawn before; nil until one has
    /// opened. Asks for the collection and opens the file when they are due.
    func frame(at time: Double) -> MosaicFrame? {
        if let opened = opened(at: time), opened != drawn {
            drawn = opened
        }
        return drawn
    }

    /// Forgets the frame drawn, as the mosaic was taken off the globe.
    func hide() {
        if drawn != nil {
            drawn = nil
        }
    }

    /// The newest Slot's file, opened once for every picture until the collection is due
    /// again; a failure is not kept, and the next picture asks again.
    func newest() async throws -> MosaicFrame {
        if let newestFrame, Date() < newestFrame.until {
            return try await value(of: newestFrame.frame)
        }
        let read = read
        let frame = Task { try await Self.openNewest(read: read) }
        newestFrame = (Date() + Self.refresh, frame)
        return try await value(of: frame)
    }

    /// A picture of the newest Slot in `bounds`, `width` by `height` pixels.
    func preview(_ bounds: SatelliteDetails.PreviewBounds, width: Int, height: Int) async throws -> CGImage {
        let frame = try await newest()
        let read = read
        let url = frame.url
        return try await frame.preview(bounds, width: width, height: height) { try await read(url, $0) }
    }

    private func value(of frame: Task<MosaicFrame, any Error>) async throws -> MosaicFrame {
        do {
            return try await frame.value
        } catch {
            if newestFrame?.frame == frame {
                newestFrame = nil
            }
            throw error
        }
    }

    /// The frame for `time` once opened, asking for the collection and opening the file
    /// when they are due.
    private func opened(at time: Double) -> MosaicFrame? {
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
        let read = read
        Task {
            let opened: Frame
            do {
                opened = .ready(try await Self.open(item: item, read: read))
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

    /// The file an item names, its header and tile index read.
    nonisolated private static func open(item: URL, read: @escaping Read) async throws -> MosaicFrame {
        let (data, response) = try await URLSession.shared.data(from: item)
        guard (response as? HTTPURLResponse)?.statusCode == 200, let file = Mosaic.file(item: data, at: item) else {
            throw URLError(.cannotParseResponse)
        }
        return try await Mosaic.open(file.url, credit: file.credit) { try await read(file.url, $0) }
    }

    /// The newest Slot the collection lists, opened.
    nonisolated private static func openNewest(read: @escaping Read) async throws -> MosaicFrame {
        guard let slots = await list(), let newest = slots.max(by: { $0.key < $1.key }) else {
            throw URLError(.cannotParseResponse)
        }
        return try await open(item: newest.value, read: read)
    }
}
