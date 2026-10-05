import Foundation
import Testing

@testable import SatvisCore

/// The passes the web app's `Orbit` finds for the parity element sets
/// (scripts/parity/generate.mjs). ADR 0008 allows a second on a start or an end.
/// The search propagates the same instants, so they agree far closer than that.
/// Elevation passes agree exactly. A swath pass agrees to the 10 ms its edges are
/// bisected to: near a closest approach the distance barely changes from one
/// millisecond to the next, so the last-bit differences between V8's and Darwin's
/// trigonometry (tens of micrometres) can tip the golden-section search a few
/// milliseconds either way.
struct PassParity: Decodable {
    struct Station: Decodable {
        let name: String
        let latitude: Double
        let longitude: Double

        var station: GroundStation {
            GroundStation(latitude: latitude, longitude: longitude, name: name.isEmpty ? nil : name)
        }
    }

    struct Swath: Decodable {
        let starboardKm: Double
        let portKm: Double
    }

    struct ExpectedPass: Decodable {
        let start: Double
        let end: Double
        let duration: Double
        let maxElevation: Double?
        let azimuthStart: Double?
        let azimuthApex: Double?
        let azimuthEnd: Double?
        let apex: Double?
        let minDistance: Double?
        let minDistanceTime: Double?
        let swathWidth: Double?
    }

    struct Case: Decodable {
        let record: Int
        let station: Int
        let startMs: Double
        let endMs: Double
        let mode: OverpassMode
        let swath: Swath?
        let passes: [ExpectedPass]
    }

    struct Row: Decodable {
        let countdown: String
        let startLabel: String
        let endLabel: String
        let primary: String
        let secondary: String
    }

    struct Layout: Decodable {
        struct Block: Decodable {
            let startMs: Double
            let leftPct: Double
            let widthPct: Double
            let heightPct: Double
            let band: String
            let live: Bool
            let past: Bool
        }

        struct Tick: Decodable {
            let label: String
            let pct: Double
        }

        let blocks: [Block]
        let ticks: [Tick]
        let nowPct: Double
        let horizonLabel: String
        let beyond: Int
    }

    struct Presentation: Decodable {
        let nowMs: Double
        let rows: [Row]
        let summaries: [String]
        let visible: Int
        let layout: Layout
    }

    struct Countdown: Decodable {
        let untilMs: Double
        let text: String
    }

    struct CompassPoint: Decodable {
        let azimuth: Double
        let point: String
    }

    let stations: [Station]
    let passes: [Case]
    let presentation: [Presentation]
    let countdowns: [Countdown]
    let compassPoints: [CompassPoint]
}

extension PassParity.ExpectedPass {
    func pass(station: String) -> Pass {
        let measure: Pass.Measure =
            if let maxElevation {
                .elevation(maxElevation: maxElevation, azimuthStart: azimuthStart!, azimuthApex: azimuthApex!, azimuthEnd: azimuthEnd!, apex: apex)
            } else {
                .swath(minDistance: minDistance!, minDistanceTime: minDistanceTime!, swathWidth: swathWidth!)
            }
        return Pass(satellite: "", satelliteName: "", station: station, stationID: UUID(), start: start, end: end, measure: measure)
    }
}

@Suite struct PassParityTests {
    @Test func findsTheWebAppsPasses() throws {
        let parity = try JSONDecoder().decode(PassParity.self, from: Parity.fixture("parity"))
        let records = try GPRecord.decodePayload(Parity.fixture("parity-input"))
        #expect(parity.passes.contains { !$0.passes.isEmpty && $0.mode == .swath && $0.swath?.starboardKm != $0.swath?.portKm })
        for expected in parity.passes {
            let record = records[expected.record]
            let station = parity.stations[expected.station].station
            let finder = PassFinder(try SGP4Propagator(record.meanElements))
            let found =
                switch expected.mode {
                case .elevation: finder.elevationPasses(over: station, from: expected.startMs, to: expected.endMs)
                case .swath:
                    finder.swathPasses(
                        over: station, swath: SwathExtents(starboardKm: expected.swath!.starboardKm, portKm: expected.swath!.portKm), from: expected.startMs,
                        to: expected.endMs)
                }
            let label = "\(record.name) over \(station.displayName), \(expected.mode)"
            #expect(found.count == expected.passes.count, "\(label)")
            for (pass, want) in zip(found, expected.passes) {
                #expect(abs(pass.start - want.start) <= 10, "\(label): start \(pass.start - want.start) ms")
                #expect(abs(pass.end - want.end) <= 10, "\(label): end \(pass.end - want.end) ms")
                switch pass.measure {
                case .elevation(let maxElevation, let azimuthStart, let azimuthApex, let azimuthEnd, let apex):
                    // The peak and the edges are searched for to 10 ms, and the last bit
                    // of a sine can steer the search either way: the azimuths agree to
                    // what a low pass sweeps in that time. A slow orbit's peak is flat to
                    // the last bit for tens of milliseconds, so its time agrees less
                    // closely than its elevation.
                    #expect(abs(maxElevation - want.maxElevation!) < 1e-6, "\(label)")
                    #expect(abs(azimuthStart - want.azimuthStart!) < 0.01, "\(label)")
                    #expect(abs(azimuthApex - want.azimuthApex!) < 0.01, "\(label)")
                    #expect(abs(azimuthEnd - want.azimuthEnd!) < 0.01, "\(label)")
                    #expect(abs(apex! - want.apex!) <= 100, "\(label)")
                case .swath(let minDistance, let minDistanceTime, let swathWidth):
                    #expect(abs(minDistance - want.minDistance!) < 1e-3, "\(label)")
                    #expect(abs(minDistanceTime - want.minDistanceTime!) <= 10, "\(label)")
                    #expect(swathWidth == want.swathWidth, "\(label)")
                }
            }
        }
    }

    // The info panel's words for the passes the web app found: rows, headline,
    // countdown, compass points and the timeline strip.
    @Test func presentsPassesAsTheWebAppDoes() throws {
        let parity = try JSONDecoder().decode(PassParity.self, from: Parity.fixture("parity"))
        let cases = parity.passes.filter { !$0.passes.isEmpty }
        #expect(cases.count == parity.presentation.count)
        for (entry, expected) in zip(cases, parity.presentation) {
            let passes = entry.passes.map { $0.pass(station: "station") }
            for (pass, row) in zip(passes, expected.rows) {
                #expect(pass.countdown(at: expected.nowMs) == row.countdown)
                #expect(pass.startLabel == row.startLabel)
                #expect(pass.endLabel == row.endLabel)
                #expect(pass.columns.primary == row.primary)
                #expect(pass.columns.secondary == row.secondary)
            }
            #expect(passes.map(\.summary) == expected.summaries)
            #expect(passes.visible(at: expected.nowMs, past: false).count == expected.visible)

            let layout = PassTimelineLayout(passes: passes, now: expected.nowMs)
            #expect(layout.blocks.count == expected.layout.blocks.count)
            for (block, want) in zip(layout.blocks, expected.layout.blocks) {
                #expect(block.start == want.startMs)
                #expect(abs(block.left * 100 - want.leftPct) < 1e-9)
                #expect(abs(block.width * 100 - want.widthPct) < 1e-9)
                #expect(abs(block.height * 100 - want.heightPct) < 1e-9)
                #expect(block.band.rawValue == want.band)
                #expect(block.isLive == want.live)
                #expect(block.isPast == want.past)
            }
            #expect(layout.ticks.map(\.label) == expected.layout.ticks.map(\.label))
            for (tick, want) in zip(layout.ticks, expected.layout.ticks) {
                #expect(abs(tick.position * 100 - want.pct) < 1e-9)
            }
            #expect(abs(layout.now * 100 - expected.layout.nowPct) < 1e-9)
            #expect(layout.horizonLabel == expected.layout.horizonLabel)
            #expect(layout.beyond == expected.layout.beyond)
        }
        for countdown in parity.countdowns {
            let pass = Pass(
                satellite: "", satelliteName: "", station: "", stationID: UUID(), start: countdown.untilMs, end: countdown.untilMs + 600_000,
                measure: .swath(minDistance: 0, minDistanceTime: 0, swathWidth: 0))
            #expect(pass.countdown(at: 0) == countdown.text, "\(countdown.untilMs)")
        }
        for sample in parity.compassPoints {
            #expect(compassPoint(sample.azimuth) == sample.point, "\(sample.azimuth)")
        }
    }
}
