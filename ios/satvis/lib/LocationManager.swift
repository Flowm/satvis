import CoreLocation
import UIKit

class LocationManager: NSObject, CLLocationManagerDelegate {
    let locationManager: CLLocationManager

    override init() {
        locationManager = CLLocationManager()
        super.init()

        locationManager.delegate = self
        locationManager.requestWhenInUseAuthorization()
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .notDetermined, .restricted, .denied:
            NSLog("Location: No access")
        case .authorizedWhenInUse:
            NSLog("Location: WhenInUse")
        case .authorizedAlways:
            NSLog("Location: Always")
        @unknown default:
            NSLog("Location: Unknown")
        }
    }
}
