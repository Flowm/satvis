import UIKit
import UserNotifications

class NotificationManager: NSObject, UNUserNotificationCenterDelegate {
    var pendingRequests: [UNNotificationRequest] = []

    override init() {
        super.init()
        registerForPushNotifications()
    }

    func registerForPushNotifications(remote: Bool = false) {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) {
            (granted, error) in
            guard error == nil else {
                NSLog("NotificationManager: ERROR \(String(describing: error))")
                return
            }
            NSLog("NotificationManager: Permission granted \(granted)")
            guard granted else {
                return
            }
            if (remote) {
                DispatchQueue.main.async {
                    UIApplication.shared.registerForRemoteNotifications()
                }
            }
        }
    }

    func createNotificationRequest(title: String,
                                   body: String,
                                   badge: Bool = false,
                                   timeInterval: Double,
                                   indentifier: String) -> UNNotificationRequest {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = UNNotificationSound.default
        if (badge) {
            content.badge = NSNumber(integerLiteral: UIApplication.shared.applicationIconBadgeNumber + 1)
        }
        let trigger = UNTimeIntervalNotificationTrigger.init(timeInterval: timeInterval, repeats: false)
        let request = UNNotificationRequest.init(identifier: indentifier, content: content, trigger: trigger)
        return request
    }

    func scheduleRequest(request: UNNotificationRequest) {
        UNUserNotificationCenter.current().add(request)
    }

    func scheduleRequestChronological(request: UNNotificationRequest) -> Bool {
        // Retrive pending notifications synchronously to ensure multiple sequential
        // notification requests don't try to remove the same notification
        updatePendingNotificationRequests()

        if (pendingRequests.count < 60) {
            NSLog("NotificationManager: Schedule \(request)")
            self.scheduleRequest(request: request)
            return true
        }

        guard let trigger = request.trigger as? UNTimeIntervalNotificationTrigger else {
            return false
        }
        let sortedRequests = pendingRequests.sorted(by: {
            if let t0 = $0.trigger as? UNTimeIntervalNotificationTrigger,
                let t1 = $1.trigger as? UNTimeIntervalNotificationTrigger {
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
                UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [pendingRequest.identifier])
                self.scheduleRequest(request: request)
                NSLog("NotificationManager: Replace \(pendingTrigger.timeInterval) by \(trigger.timeInterval)")
                return true
            }
        }
        return false
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.alert, .sound])
    }

    func updatePendingNotificationRequests() {
        let semaphore = DispatchSemaphore(value: 0)
        UNUserNotificationCenter.current().getPendingNotificationRequests(completionHandler: { requests in
            self.pendingRequests = requests
            semaphore.signal()
            return
        })
        semaphore.wait()
    }

    func printPendingNotifications() {
        UNUserNotificationCenter.current().getPendingNotificationRequests(completionHandler: { requests in
            for request in requests {
                print(request)
            }
        })
    }

    func clearNotifications(clearPending: Bool = true) {
        UIApplication.shared.applicationIconBadgeNumber = 0
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        if (clearPending) {
            UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
        }
    }
}
