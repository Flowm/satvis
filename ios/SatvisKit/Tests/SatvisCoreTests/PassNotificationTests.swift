import Foundation
import Testing

@testable import SatvisCore

@Suite struct PassNotificationTests {
    private let now = 1_800_000_000_000.0
    private let station = UUID()

    private func pass(_ minutesAhead: Double, satellite: String = "1|SAT") -> Pass {
        let start = now + minutesAhead * 60_000
        return Pass(
            satellite: satellite, satelliteName: "SAT", station: "Home", stationID: station, start: start, end: start + 600_000,
            measure: .elevation(maxElevation: 40, azimuthStart: 0, azimuthApex: 90, azimuthEnd: 180, apex: nil))
    }

    // One notice five minutes before and one as it starts, the earliest first.
    @Test func noticesEachPassTwice() {
        let plan = PassNotificationPlan(passes: [pass(60), pass(30)], now: now, predictedUntil: now + 86_400_000)
        #expect(plan.notices.map(\.fire) == [25, 30, 55, 60].map { now + $0 * 60_000 })
        #expect(plan.passCount == 2)
        #expect(plan.coveredUntil == now + 86_400_000)
        #expect(!plan.isCutShort)
    }

    // A pass starting within the five minutes still gets its "starting now".
    @Test func keepsTheStartOfAPassTooCloseToWarnOf() {
        let plan = PassNotificationPlan(passes: [pass(2)], now: now, predictedUntil: now + 86_400_000)
        #expect(plan.notices.map(\.lead) == [0])
    }

    // More passes than iOS keeps notifications for: covered only until the last
    // one kept, and woken an hour before that.
    @Test func saysHowFarTheLimitReaches() {
        let passes = (1...50).map { pass(Double($0) * 5, satellite: "\($0)|SAT") }
        let plan = PassNotificationPlan(passes: passes, now: now, predictedUntil: now + 4 * 86_400_000)
        #expect(plan.notices.count == PassNotificationPlan.limit)
        #expect(plan.isCutShort)
        #expect(plan.coveredUntil == plan.notices.last?.fire)
        #expect(plan.refresh(after: now) == plan.coveredUntil - 3_600_000)
    }

    @Test func wakesWithinFourHoursAndNotWithinAQuarter() {
        let far = PassNotificationPlan(passes: [pass(60)], now: now, predictedUntil: now + 4 * 86_400_000)
        #expect(far.refresh(after: now) == now + 4 * 3_600_000)
        let soon = PassNotificationPlan(passes: (1...40).map { pass(Double($0), satellite: "\($0)|SAT") }, now: now, predictedUntil: now + 86_400_000)
        #expect(soon.refresh(after: now) == now + 15 * 60_000)
    }
}

@Suite struct PassAlertPlanningTests {
    private let now = 1_800_000_000_000.0
    private let home = GroundStation(latitude: 48.1351, longitude: 11.582, name: "Home")
    private let work = GroundStation(latitude: 52.52, longitude: 13.405, name: "Work")

    private func catalog() throws -> Catalog {
        var catalog = Catalog()
        catalog.add(try GPRecord.decodePayload(Parity.fixture("parity-input")), tags: [], group: "parity")
        return catalog
    }

    /// A pass every `every` minutes over each station, from `first` minutes ahead,
    /// four a satellite, with no SGP4.
    private func predictor(first: Double = 30, every: Double = 60) -> PassNotificationPlan.Predictor {
        { entry, settings, _ in
            settings.stations.flatMap { station in
                (0..<4).map { index in
                    let start = 1_800_000_000_000.0 + (first + Double(index) * every) * 60_000
                    return Pass(
                        satellite: entry.id, satelliteName: entry.name, station: station.displayName, stationID: station.id, start: start,
                        end: start + 600_000, measure: .elevation(maxElevation: 40, azimuthStart: 0, azimuthApex: 90, azimuthEnd: 180, apex: nil))
                }
            }
        }
    }

    private func plan(_ alerts: [PassAlert], stations: [GroundStation], predict: PassNotificationPlan.Predictor? = nil) async throws
        -> PassNotificationPlan
    {
        let now = now
        return try #require(
            await PassNotificationPlan.planning(
                alerts, in: try catalog(), settings: PassStore.Settings(stations: stations), at: now, clock: { now }, predict: predict ?? predictor()))
    }

    // A satellite's alert is over every saved station, a station's over that one,
    // and once the station is deleted, over none.
    @Test func plansAStationsAlertOverItAloneAndNothingOnceItIsGone() async throws {
        let iss = "25544|ISS (ZARYA)"
        let both = try await plan([PassAlert(subject: .satellite(iss), satellites: [iss], groups: ["parity"])], stations: [home, work])
        #expect(Set(both.notices.map(\.pass.stationID)) == [home.id, work.id])

        let alert = PassAlert(subject: .station(work.id), satellites: [iss], groups: ["parity"])
        let one = try await plan([alert], stations: [home, work])
        #expect(Set(one.notices.map(\.pass.stationID)) == [work.id])
        let gone = try await plan([alert], stations: [home])
        #expect(gone.notices.isEmpty)
    }

    // CelesTrak names a new launch "OBJECT A" until it knows: the alert follows
    // the catalog number to the new name.
    @Test func followsASatelliteRenamedByItsCatalogNumber() async throws {
        let alert = PassAlert(subject: .satellite("25544|OBJECT A"), satellites: ["25544|OBJECT A"], groups: ["parity"])
        let plan = try await plan([alert], stations: [home])
        #expect(plan.passCount == 4)
        #expect(plan.notices.allSatisfy { $0.pass.satellite == "25544|ISS (ZARYA)" })
    }

    @Test func leavesOutSatellitesOfAGroupNotLoaded() async throws {
        let alerts = [
            PassAlert(subject: .satellite("99999|GONE"), satellites: ["99999|GONE"], groups: ["missing"]),
            PassAlert(subject: .station(home.id), satellites: ["99998|ALSO GONE", "43689|METOP-C"], groups: ["missing", "parity"]),
        ]
        let plan = try await plan(alerts, stations: [home])
        #expect(Set(plan.notices.map(\.pass.satellite)) == ["43689|METOP-C"])
    }

    // Five satellites over two stations, a pass every 15 minutes from 30 minutes
    // ahead: 80 notices, the station's alert repeating passes the satellites'
    // alerts have. The earliest 64 are those up to the hour, 60, and 4 of the 10
    // that fire at 70 minutes.
    @Test func keepsTheEarliestAcrossAlerts() async throws {
        let ids = ["25544|ISS (ZARYA)", "43689|METOP-C", "26407|GPS BIIR-5  (PRN 22)", "60133|GOES 19", "23802|POLAR"]
        let alerts =
            ids.map { PassAlert(subject: .satellite($0), satellites: [$0], groups: ["parity"]) } + [
                PassAlert(subject: .station(work.id), satellites: ids, groups: ["parity"])
            ]
        let plan = try await plan(alerts, stations: [home, work], predict: predictor(every: 15))
        #expect(plan.notices.count == PassNotificationPlan.limit)
        #expect(plan.isCutShort)
        #expect(plan.notices.map(\.fire) == plan.notices.map(\.fire).sorted())
        #expect(Set(plan.notices).count == plan.notices.count)
        #expect(plan.notices.count { $0.fire <= now + 60 * 60_000 } == 60)
        #expect(plan.coveredUntil == now + 70 * 60_000)
    }

    @Test func writesTheNotificationsAndTheSummary() async throws {
        let iss = "25544|ISS (ZARYA)"
        let plan = try await plan([PassAlert(subject: .satellite(iss), satellites: [iss], groups: ["parity"])], stations: [home])
        let first = try #require(plan.notices.first)
        #expect(first.title == "ISS (ZARYA) pass in 5 minutes")
        #expect(first.body == "Over Home · 10 min · 40° max, apex E")
        #expect(first.identifier == "pass|25544|ISS (ZARYA)|\(home.id.uuidString)|\(Int(now + 30 * 60_000))|300000")
        let second = plan.notices[1]
        #expect(second.title == "ISS (ZARYA) pass starting now")
        #expect(second.identifier.hasSuffix("|0"))
        #expect(plan.summary == "Notifying for 4 passes")

        let one = PassNotificationPlan(passes: [first.pass], now: now, predictedUntil: now + 86_400_000)
        #expect(one.summary == "Notifying for 1 pass")
        #expect(PassNotificationPlan(passes: [], now: now, predictedUntil: now).summary == "No passes in the next four days")
        let short = PassNotificationPlan(passes: [first.pass], now: now, predictedUntil: now + 86_400_000, limit: 1)
        #expect(short.summary.hasPrefix("Notifying for 1 pass until "))
    }

    // As the app's own `Alert` type saved them before it moved here, byte for byte,
    // the slash escaped as JSONEncoder does: a satellite's alert; one saved before
    // stations had ids, holding the station itself, which drops alone; a station's.
    @Test func readsSavedAlertsDroppingThoseOfAnOlderShape() throws {
        let saved =
            #"[{"groups":["stations"],"subject":{"satellite":{"_0":"25544|ISS (ZARYA)"}},"satellites":["25544|ISS (ZARYA)"]},"#
            + #"{"groups":["stations"],"subject":{"station":{"_0":{"name":"Munich","latitude":48.1372,"longitude":11.5756}}},"satellites":["25544|ISS (ZARYA)"]},"#
            + #"{"groups":["last-30-days","weather"],"subject":{"station":{"_0":"6F1C2A3E-8B4D-4E5F-9A0B-1C2D3E4F5A6B"}},"satellites":["43689|METOP-C","49045|SL-4 R\/B"]}]"#
        let id = try #require(UUID(uuidString: "6F1C2A3E-8B4D-4E5F-9A0B-1C2D3E4F5A6B"))
        let alerts = PassAlert.decodeAll(from: Data(saved.utf8))
        #expect(
            alerts == [
                PassAlert(subject: .satellite("25544|ISS (ZARYA)"), satellites: ["25544|ISS (ZARYA)"], groups: ["stations"]),
                PassAlert(subject: .station(id), satellites: ["43689|METOP-C", "49045|SL-4 R/B"], groups: ["last-30-days", "weather"]),
            ])
        #expect(PassAlert.decodeAll(from: try JSONEncoder().encode(alerts)) == alerts)
        #expect(PassAlert.decodeAll(from: Data("not json".utf8)).isEmpty)
    }
}
