import BackgroundTasks
import Foundation
import Observation
import SatvisCore
import SatvisData
import UserNotifications
import os

private let log = Logger(subsystem: "org.frcy.app.satvis", category: "notifications")

/// Notifications for the passes of what the user asked about: five minutes before
/// each pass and as it starts, as the web app sends them. Unlike the web app's,
/// they are kept: every launch, return to the foreground and background refresh
/// predicts them again from the newest element sets, four days ahead.
@Observable
final class PassAlerts {
    /// One thing to be told about: a satellite's passes over every station, or the
    /// passes over one station of the satellites active when it was asked.
    struct Alert: Codable, Hashable {
        enum Subject: Codable, Hashable {
            /// A catalog id.
            case satellite(String)
            /// A ground station's id: renamed or moved, it is still the one asked
            /// about, and deleted, its alert goes with it.
            case station(UUID)
        }

        var subject: Subject
        /// Catalog ids.
        var satellites: [String]
        /// The groups they come in, to load them from without the catalog.
        var groups: [String]
    }

    static let refreshTaskID = "org.frcy.app.satvis.passes"
    /// Notifications iOS keeps pending for an app.
    private static let limit = 64
    private static let key = "passAlerts"
    private static let leadMs = 5 * 60_000.0
    private static let identifierPrefix = "pass|"

    private(set) var alerts: [Alert]
    /// What the last change came to, for a moment: "Notifying for 12 passes".
    private(set) var message: String?
    @ObservationIgnored private let source: GPSource
    @ObservationIgnored private let center = UNUserNotificationCenter.current()
    @ObservationIgnored private let presenter = Presenter()
    @ObservationIgnored private var scheduling: Task<Int, Never>?
    @ObservationIgnored private var clearing: Task<Void, Never>?

    init(source: GPSource) {
        self.source = source
        // One at a time, so an alert saved in an older shape drops alone.
        alerts = (UserDefaults.standard.data(forKey: Self.key).flatMap { try? JSONDecoder().decode([MaybeAlert].self, from: $0) } ?? []).compactMap(\.value)
        center.delegate = presenter
    }

    func isOn(_ subject: Alert.Subject) -> Bool {
        alerts.contains { $0.subject == subject }
    }

    /// Asks for permission the first time, then schedules.
    func turnOn(_ subject: Alert.Subject, satellites: [CatalogEntry]) async {
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
        guard granted else {
            show("Notifications are off for SatVis in Settings")
            return
        }
        alerts.removeAll { $0.subject == subject }
        alerts.append(Alert(subject: subject, satellites: satellites.map(\.id), groups: Array(Set(satellites.flatMap(\.groups))).sorted()))
        save()
        let count = await reschedule()
        show(count == 0 ? "No passes in the next four days" : "Notifying for \(count) \(count == 1 ? "pass" : "passes")")
    }

    /// Drops the alerts of stations that are gone.
    func forgetStations(except kept: Set<UUID>) {
        let before = alerts.count
        alerts.removeAll {
            if case .station(let id) = $0.subject {
                return !kept.contains(id)
            }
            return false
        }
        if alerts.count != before {
            save()
        }
    }

    func turnOff(_ subject: Alert.Subject) async {
        alerts.removeAll { $0.subject == subject }
        save()
        await reschedule()
    }

    /// Predicts every alert's passes from now and replaces the pending
    /// notifications with the earliest of them. One at a time.
    @discardableResult
    func reschedule() async -> Int {
        let previous = scheduling
        let task = Task {
            _ = await previous?.value
            return await self.schedule()
        }
        scheduling = task
        return await task.value
    }

    /// Asks iOS to wake the app in a few hours to predict again, while there is
    /// anything to predict.
    func requestRefresh() {
        guard !alerts.isEmpty else {
            BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.refreshTaskID)
            return
        }
        let request = BGAppRefreshTaskRequest(identifier: Self.refreshTaskID)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 4 * 3600)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            log.error("No background refresh: \(error, privacy: .public)")
        }
    }

    private func schedule() async -> Int {
        let settings = PassModel.storedSettings()
        guard !alerts.isEmpty, !settings.stations.isEmpty else {
            await removePending()
            return 0
        }
        var catalog = Catalog()
        for group in Set(alerts.flatMap(\.groups)) {
            do {
                catalog.add(try await source.records(of: group).value, tags: [], group: group)
            } catch {
                log.error("Group \(group, privacy: .public) unavailable: \(error, privacy: .public)")
            }
        }
        let now = Date().timeIntervalSince1970 * 1000
        let lead = Self.leadMs
        let jobs = alerts.flatMap { alert in
            let stations: [GroundStation]
            switch alert.subject {
            case .satellite: stations = settings.stations
            case .station(let id): stations = settings.stations.filter { $0.id == id }
            }
            return alert.satellites.compactMap { Self.entry($0, in: catalog) }.map { ($0, PassStore.Settings(stations: stations, mode: settings.mode)) }
        }
        let passes = await Task.detached(priority: .utility) {
            let window = PassWindow(around: now)
            return Set(jobs.flatMap { PassStore.predict($0.0, settings: $0.1, window: window) }).filter { $0.start - lead > now }
        }.value
        let upcoming = passes.sorted { $0.start < $1.start }.prefix(Self.limit / 2)
        // Only now, so that the ones pending keep firing while the groups load,
        // which on a slow network takes a while.
        await removePending()
        for pass in upcoming {
            for lead in [Self.leadMs, 0] {
                await add(pass, lead: lead)
            }
        }
        log.notice("Scheduled \(upcoming.count) passes")
        return upcoming.count
    }

    /// A satellite by its catalog id, or by its catalog number when it has been
    /// renamed since: CelesTrak names a new launch "OBJECT A" until it knows.
    private static func entry(_ id: String, in catalog: Catalog) -> CatalogEntry? {
        if let entry = catalog.entries[id] {
            return entry
        }
        let satnum = id.split(separator: "|").first.map(String.init)
        return catalog.entries.values.first { $0.satnum == satnum }
    }

    private func removePending() async {
        let pending = await center.pendingNotificationRequests().map(\.identifier).filter { $0.hasPrefix(Self.identifierPrefix) }
        center.removePendingNotificationRequests(withIdentifiers: pending)
    }

    private func add(_ pass: Pass, lead: Double) async {
        let content = UNMutableNotificationContent()
        content.title = lead > 0 ? "\(pass.satelliteName) pass in \(Int(lead / 60_000)) minutes" : "\(pass.satelliteName) pass starting now"
        // The title says when; a window in UTC would only make the reader convert it.
        content.body = "Over \(pass.station) · \(pass.length)"
        content.sound = .default
        // An interval rather than calendar components, which iOS reads in the
        // device's time zone whatever zone they were taken in.
        let interval = (pass.start - lead) / 1000 - Date().timeIntervalSince1970
        guard interval > 0 else {
            return
        }
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: interval, repeats: false)
        let identifier = "\(Self.identifierPrefix)\(pass.satellite)|\(pass.stationID.uuidString)|\(Int(pass.start))|\(Int(lead))"
        do {
            try await center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: trigger))
        } catch {
            log.error("Scheduling failed: \(error, privacy: .public)")
        }
    }

    private func save() {
        UserDefaults.standard.set(try? JSONEncoder().encode(alerts), forKey: Self.key)
        requestRefresh()
    }

    private func show(_ text: String) {
        message = text
        clearing?.cancel()
        clearing = Task {
            try? await Task.sleep(for: .seconds(3))
            if !Task.isCancelled {
                message = nil
            }
        }
    }
}

/// An alert, or nil for one that no longer decodes.
private struct MaybeAlert: Decodable {
    let value: PassAlerts.Alert?

    init(from decoder: Decoder) throws {
        value = try? PassAlerts.Alert(from: decoder)
    }
}

/// Shows a pass notification that arrives while the app is open, too.
private final class Presenter: NSObject, UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }
}
