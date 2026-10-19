import Foundation

/// One thing to be told about: a satellite's passes over every station, or the
/// passes over one station of the satellites active when it was asked.
public struct PassAlert: Codable, Hashable, Sendable {
    public enum Subject: Codable, Hashable, Sendable {
        /// A catalog id.
        case satellite(String)
        /// A ground station's id: renamed or moved, it is still the one asked
        /// about, and deleted, its alert goes with it.
        case station(UUID)
    }

    public var subject: Subject
    /// Catalog ids.
    public var satellites: [String]
    /// The groups they come in, to load them from without the catalog.
    public var groups: [String]

    public init(subject: Subject, satellites: [String], groups: [String]) {
        self.subject = subject
        self.satellites = satellites
        self.groups = groups
    }

    /// For these satellites, with the groups that serve them.
    public init(subject: Subject, satellites: [CatalogEntry]) {
        self.init(subject: subject, satellites: satellites.map(\.id), groups: Array(Set(satellites.flatMap(\.groups))).sorted())
    }

    /// Alerts as saved, read one at a time, so an alert saved in an older shape
    /// drops alone.
    public static func decodeAll(from data: Data) -> [PassAlert] {
        ((try? JSONDecoder().decode([Lenient].self, from: data)) ?? []).compactMap(\.value)
    }

    /// The stations its passes are over, out of the saved ones.
    func stations(among saved: [GroundStation]) -> [GroundStation] {
        switch subject {
        case .satellite: saved
        case .station(let id): saved.filter { $0.id == id }
        }
    }

    /// An alert, or nil for one that no longer decodes.
    private struct Lenient: Decodable {
        let value: PassAlert?

        init(from decoder: Decoder) throws {
            value = try? PassAlert(from: decoder)
        }
    }
}

/// Which pass notifications to keep pending, out of every pass predicted for the
/// alerts: one before each pass and one as it starts, the earliest first, as many
/// as iOS keeps for an app. And how long that covers, so the app can ask to be
/// woken before it runs out.
public struct PassNotificationPlan: Sendable {
    public struct Notice: Sendable, Hashable {
        public var pass: Pass
        /// How long before the pass it fires, in milliseconds: 0 as it starts.
        public var lead: Double
        /// When it fires, in UTC milliseconds since 1970.
        public var fire: Double

        /// One per pass, station and lead, under `identifierPrefix`.
        public var identifier: String {
            "\(PassNotificationPlan.identifierPrefix)\(pass.satellite)|\(pass.stationID.uuidString)|\(Int(pass.start))|\(Int(lead))"
        }

        /// "ISS (ZARYA) pass in 5 minutes", or "… pass starting now".
        public var title: String {
            lead > 0 ? "\(pass.satelliteName) pass in \(Int(lead / 60_000)) minutes" : "\(pass.satelliteName) pass starting now"
        }

        /// Where, and what the pass is like. The title says when; a window in UTC
        /// would only make the reader convert it.
        public var body: String {
            "Over \(pass.station) · \(pass.length)"
        }
    }

    /// Notifications iOS keeps pending for an app.
    public static let limit = 64
    public static let lead = 5 * 60_000.0
    /// What every pass notification's identifier starts with, to tell them from
    /// any other the app has pending.
    public static let identifierPrefix = "pass|"

    /// By when they fire.
    public let notices: [Notice]
    /// Until when the notices cover every pass: the prediction's end, or sooner
    /// when there were more than iOS keeps. Nothing is pending after it.
    public let coveredUntil: Double
    /// Whether there were more notices than iOS keeps, so the passes after
    /// `coveredUntil` wait for the next plan.
    public let isCutShort: Bool

    /// How many passes the notices are for.
    public var passCount: Int {
        Set(notices.map(\.pass)).count
    }

    /// Every notice still to come. A pass starting within the lead keeps its
    /// notice for the start.
    public init(passes: some Sequence<Pass>, now: Double, predictedUntil: Double, limit: Int = Self.limit, lead: Double = Self.lead) {
        let all = Set(passes).flatMap { pass in
            [lead, 0].map { Notice(pass: pass, lead: $0, fire: pass.start - $0) }
        }.filter { $0.fire > now }.sorted { ($0.fire, $0.lead) < ($1.fire, $1.lead) }
        notices = Array(all.prefix(limit))
        isCutShort = all.count > limit
        coveredUntil = isCutShort ? notices.last?.fire ?? now : predictedUntil
    }

    /// "Notifying for 12 passes", and until when, in the device's time zone,
    /// when that is short of the four days predicted.
    public var summary: String {
        let count = passCount
        guard count > 0 else {
            return "No passes in the next four days"
        }
        let passes = "Notifying for \(count) \(count == 1 ? "pass" : "passes")"
        guard isCutShort else {
            return passes
        }
        let until = Date(timeIntervalSince1970: coveredUntil / 1000)
        return "\(passes) until \(until.formatted(.dateTime.weekday().hour().minute()))"
    }

    /// When to ask to be woken to plan again: an hour before the notices run out,
    /// but not sooner than a quarter of an hour, nor later than four hours, from now.
    public func refresh(after now: Double) -> Double {
        min(max(coveredUntil - 3_600_000, now + 15 * 60_000), now + 4 * 3_600_000)
    }
}

extension PassNotificationPlan {
    /// One satellite's passes over the stations, inside the window.
    public typealias Predictor = @Sendable (CatalogEntry, PassStore.Settings, PassWindow) -> [Pass]

    /// Predicts the alerts' passes from `now`, four days ahead, and plans their
    /// notices. A satellite renamed since it was asked about is followed by its
    /// catalog number; one the catalog lacks, its group unavailable, is left out.
    /// Prediction takes a while, so `clock` is read again after it, and nothing
    /// already past is planned. Nil when cancelled.
    public static func planning(
        _ alerts: [PassAlert], in catalog: Catalog, settings: PassStore.Settings, at now: Double,
        clock: @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 },
        predict: @escaping Predictor = { PassStore.predict($0, settings: $1, window: $2) }
    ) async -> PassNotificationPlan? {
        let jobs = alerts.flatMap { alert in
            let settings = PassStore.Settings(stations: alert.stations(among: settings.stations), mode: settings.mode)
            return alert.satellites.compactMap { catalog.entry(orSuccessorOf: $0) }.map { ($0, settings) }
        }
        let window = PassWindow(around: now)
        let prediction = Task.detached(priority: .utility) { await Self.predict(jobs, window: window, with: predict) }
        let passes = await withTaskCancellationHandler {
            await prediction.value
        } onCancel: {
            prediction.cancel()
        }
        guard !Task.isCancelled else {
            return nil
        }
        return PassNotificationPlan(passes: passes, now: clock(), predictedUntil: window.predictionEnd)
    }

    /// Every pass of every job, side by side. Stops early when cancelled.
    private static func predict(_ jobs: [(CatalogEntry, PassStore.Settings)], window: PassWindow, with predict: @escaping Predictor) async -> [Pass] {
        await withTaskGroup(of: [Pass].self) { group in
            for job in jobs {
                group.addTask {
                    Task.isCancelled ? [] : predict(job.0, job.1, window)
                }
            }
            return await group.reduce(into: []) { $0 += $1 }
        }
    }
}
