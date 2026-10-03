import UIKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    var notificationManager: NotificationManager!
    var locationManager: LocationManager!

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        self.notificationManager = NotificationManager.init()
        self.locationManager = LocationManager.init()
        return true
    }

    static func shared() -> AppDelegate {
        return UIApplication.shared.delegate as! AppDelegate
    }
}
