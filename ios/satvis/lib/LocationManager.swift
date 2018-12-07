import UIKit
import CoreLocation

class LocationManager: NSObject, CLLocationManagerDelegate {
    let locationManager: CLLocationManager

    override init() {
        locationManager = CLLocationManager()
        super.init()

        locationManager.delegate = self
        locationManager.requestWhenInUseAuthorization()

        if CLLocationManager.locationServicesEnabled() {
            switch CLLocationManager.authorizationStatus() {
            case .notDetermined, .restricted, .denied:
                NSLog("Location: No access")
            case .authorizedWhenInUse:
                NSLog("Location: WhenInUse")
            case .authorizedAlways:
                NSLog("Location: Always")
            }
        } else {
            NSLog("Location services are not enabled")
        }
    }
}
