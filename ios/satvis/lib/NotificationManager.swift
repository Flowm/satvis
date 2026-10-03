import UIKit
import UserNotifications
import os

nonisolated private let log = Logger(subsystem: "org.frcy.app.satvis", category: "notifications")

class NotificationManager: NSObject, UNUserNotificationCenterDelegate {
    private let center = UNUserNotificationCenter.current()
    // Runs scheduling one request at a time, so sequential requests
    // don't try to remove the same pending notification
    private var lastSchedule: Task<Bool, Never>?

    override init() {
        super.init()
        center.delegate = self
    }

    // Asks on the first notification rather than at launch
    private func requestAuthorization() async -> Bool {
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
            log.debug("Permission granted: \(granted)")
            return granted
        } catch {
            log.error("Permission request failed: \(error)")
            return false
        }
    }

    func createNotificationRequest(
        title: String,
        body: String,
        timeInterval: Double,
        identifier: String
    ) -> UNNotificationRequest {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = UNNotificationSound.default
        let trigger = UNTimeIntervalNotificationTrigger.init(timeInterval: timeInterval, repeats: false)
        let request = UNNotificationRequest.init(identifier: identifier, content: content, trigger: trigger)
        return request
    }

    func scheduleRequest(request: UNNotificationRequest) async {
        do {
            try await center.add(request)
        } catch {
            log.error("Scheduling failed: \(error)")
        }
    }

    func scheduleRequestChronological(request: UNNotificationRequest) async -> Bool {
        let previous = lastSchedule
        let task = Task {
            _ = await previous?.value
            guard await self.requestAuthorization() else {
                return false
            }
            return await self.insertChronologically(request: request)
        }
        lastSchedule = task
        return await task.value
    }

    private func insertChronologically(request: UNNotificationRequest) async -> Bool {
        let pendingRequests = await center.pendingNotificationRequests()

        if pendingRequests.count < 60 {
            log.notice("Schedule \(request.identifier, privacy: .public)")
            await self.scheduleRequest(request: request)
            return true
        }

        guard let trigger = request.trigger as? UNTimeIntervalNotificationTrigger else {
            return false
        }
        let sortedRequests = pendingRequests.sorted(by: {
            if let t0 = $0.trigger as? UNTimeIntervalNotificationTrigger,
                let t1 = $1.trigger as? UNTimeIntervalNotificationTrigger
            {
                return t0.timeInterval < t1.timeInterval
            } else {
                return true
            }
        })
        for pendingRequest in sortedRequests.reversed() {
            guard let pendingTrigger = pendingRequest.trigger as? UNTimeIntervalNotificationTrigger else {
                return false
            }
            if trigger.timeInterval < pendingTrigger.timeInterval {
                center.removePendingNotificationRequests(withIdentifiers: [pendingRequest.identifier])
                await self.scheduleRequest(request: request)
                log.notice("Replace \(pendingTrigger.timeInterval)s by \(trigger.timeInterval)s")
                return true
            }
        }
        return false
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        return [.banner, .list, .sound]
    }

    func printPendingNotifications() {
        center.getPendingNotificationRequests(completionHandler: { requests in
            for request in requests {
                log.debug("Pending \(request.identifier, privacy: .public)")
            }
        })
    }

    func clearNotifications(clearPending: Bool = true) {
        center.setBadgeCount(0)
        center.removeAllDeliveredNotifications()
        if clearPending {
            center.removeAllPendingNotificationRequests()
        }
    }
}
