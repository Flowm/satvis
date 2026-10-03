import SwiftUI

@main
struct SatvisApp: App {
    @State private var notificationManager = NotificationManager()
    @State private var locationManager = LocationManager()

    var body: some Scene {
        WindowGroup {
            SatvisWebView(url: url, notificationManager: notificationManager)
                .ignoresSafeArea()
                .background(.black)
                .preferredColorScheme(.dark)
        }
    }

    private var url: URL {
        ProcessInfo.processInfo.environment["URL"].flatMap(URL.init(string:)) ?? URL(string: "https://satvis.space/")!
    }
}
