import Foundation
import Observation
import SatvisCore
import SatvisData
import UserNotifications
import os

#if canImport(BackgroundTasks)
    import BackgroundTasks
#endif

nonisolated private let log = Logger(subsystem: "org.frcy.app.satvis", category: "notifications")

/// Notifications for the passes of what the user asked about: five minutes before
/// each pass and as it starts, as the web app sends them. Unlike the web app's,
/// they are kept: every launch, return to the foreground and background refresh
/// predicts them again from the newest element sets, four days ahead.
@Observable
final class PassAlerts {
    static let refreshTaskID = "org.frcy.app.satvis.passes"
    private static let key = "passAlerts"

    private(set) var alerts: [PassAlert]
    /// What the last change came to, for a moment: "Notifying for 12 passes".
    private(set) var message: String?
    @ObservationIgnored private let loader: GroupLoader
    /// Where the stations and mode are read from, with no `PassModel` about in a
    /// background refresh.
    @ObservationIgnored private let stationStorage: StationStorage
    @ObservationIgnored private let center = UNUserNotificationCenter.current()
    @ObservationIgnored private let presenter = Presenter()
    @ObservationIgnored private var scheduling: Task<PassNotificationPlan?, Never>?
    /// When the last plan wanted to be woken to plan again.
    @ObservationIgnored private var nextRefresh: Date?
    @ObservationIgnored private var clearing: Task<Void, Never>?
    #if os(macOS)
        /// The wait for the next prediction, standing in for iOS's background refresh.
        @ObservationIgnored private var refreshing: Task<Void, Never>?
    #endif

    init(loader: GroupLoader, stationStorage: StationStorage = .app) {
        self.loader = loader
        self.stationStorage = stationStorage
        alerts = UserDefaults.standard.data(forKey: Self.key).map(PassAlert.decodeAll) ?? []
        center.delegate = presenter
    }

    func isOn(_ subject: PassAlert.Subject) -> Bool {
        alerts.contains { $0.subject == subject }
    }

    /// Asks for permission the first time, then schedules.
    func turnOn(_ subject: PassAlert.Subject, satellites: [CatalogEntry]) async {
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
        guard granted else {
            show("Notifications are off for Satvis in Settings")
            return
        }
        alerts.removeAll { $0.subject == subject }
        alerts.append(PassAlert(subject: subject, satellites: satellites))
        save()
        guard let plan = await reschedule() else {
            return
        }
        show(plan.summary)
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

    func turnOff(_ subject: PassAlert.Subject) async {
        alerts.removeAll { $0.subject == subject }
        save()
        await reschedule()
    }

    /// Predicts every alert's passes from now and replaces the pending
    /// notifications with the earliest of them. One at a time. Cancelled, as a
    /// background refresh is when its time runs out, it leaves the pending ones
    /// as they were. Nil when it did not finish.
    @discardableResult
    func reschedule() async -> PassNotificationPlan? {
        let previous = scheduling
        let task = Task {
            _ = await previous?.value
            return await self.schedule()
        }
        scheduling = task
        let plan = await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
        // The next refresh is due by the new plan: at launch, on activation and
        // after each edit alike.
        if plan != nil {
            requestRefresh()
        }
        return plan
    }

    /// Asks iOS to wake the app to predict again before the pending notifications
    /// run out, within four hours, while there is anything to predict. A Mac has
    /// no background refresh: it predicts again then while the app runs, and once
    /// it quits, the notifications already scheduled still come.
    func requestRefresh() {
        // Nothing to predict without a saved station either, as `schedule` finds.
        guard !alerts.isEmpty, !stationStorage.passSettings.stations.isEmpty else {
            #if os(macOS)
                refreshing?.cancel()
            #else
                BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.refreshTaskID)
            #endif
            return
        }
        let begin = nextRefresh.map { max($0, Date()) } ?? Date(timeIntervalSinceNow: 4 * 3600)
        #if os(macOS)
            refreshing?.cancel()
            refreshing = Task { [weak self] in
                // No sooner than iOS would wake the app, so a plan due already
                // cannot spin.
                try? await Task.sleep(for: .seconds(max(begin.timeIntervalSinceNow, 15 * 60)))
                guard let self, !Task.isCancelled else {
                    return
                }
                await reschedule()
            }
        #else
            let request = BGAppRefreshTaskRequest(identifier: Self.refreshTaskID)
            request.earliestBeginDate = begin
            do {
                try BGTaskScheduler.shared.submit(request)
            } catch {
                log.error("No background refresh: \(error, privacy: .public)")
            }
        #endif
    }

    private func schedule() async -> PassNotificationPlan? {
        let settings = stationStorage.passSettings
        guard !alerts.isEmpty, !settings.stations.isEmpty else {
            await removePending()
            nextRefresh = nil
            return PassNotificationPlan(passes: [], now: 0, predictedUntil: 0)
        }
        let catalog = await loader.catalog(of: Set(alerts.flatMap(\.groups)))
        let now = Date().timeIntervalSince1970 * 1000
        guard let plan = await PassNotificationPlan.planning(alerts, in: catalog, settings: settings, at: now) else {
            log.notice("Rescheduling cancelled; the pending notifications stay")
            return nil
        }
        // Only now, so that the ones pending keep firing while the groups load,
        // which on a slow network takes a while.
        await removePending()
        for notice in plan.notices {
            await add(notice)
        }
        nextRefresh = Date(timeIntervalSince1970: plan.refresh(after: now) / 1000)
        log.notice("Scheduled \(plan.notices.count) notifications for \(plan.passCount) passes")
        return plan
    }

    private func removePending() async {
        let pending = await center.pendingNotificationRequests().map(\.identifier).filter { $0.hasPrefix(PassNotificationPlan.identifierPrefix) }
        center.removePendingNotificationRequests(withIdentifiers: pending)
    }

    private func add(_ notice: PassNotificationPlan.Notice) async {
        let content = UNMutableNotificationContent()
        content.title = notice.title
        content.body = notice.body
        content.sound = .default
        // An interval rather than calendar components, which iOS reads in the
        // device's time zone whatever zone they were taken in.
        let interval = notice.fire / 1000 - Date().timeIntervalSince1970
        guard interval > 0 else {
            return
        }
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: interval, repeats: false)
        do {
            try await center.add(UNNotificationRequest(identifier: notice.identifier, content: content, trigger: trigger))
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

/// Shows a pass notification that arrives while the app is open, too.
private final class Presenter: NSObject, UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }
}
