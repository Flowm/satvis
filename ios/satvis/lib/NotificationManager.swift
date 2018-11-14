import UIKit
import UserNotifications

class NotificationManager: NSObject, UNUserNotificationCenterDelegate {
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

    func triggerNotification(title: String,
                             body: String,
                             badge: Bool = false,
                             timeInterval: Double,
                             indentifier: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = UNNotificationSound.default
        if (badge) {
            content.badge = NSNumber(integerLiteral: UIApplication.shared.applicationIconBadgeNumber + 1)
        }
        let trigger = UNTimeIntervalNotificationTrigger.init(timeInterval: timeInterval, repeats: false)
        let request = UNNotificationRequest.init(identifier: indentifier, content: content, trigger: trigger)
        UNUserNotificationCenter.current().add(request)
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.alert, .sound])
    }

    func clearNotifications(clearPending: Bool = true) {
        UIApplication.shared.applicationIconBadgeNumber = 0
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        if (clearPending) {
            UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
        }
    }
}
