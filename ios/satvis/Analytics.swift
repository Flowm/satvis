import Foundation
import Observation
import PostHog
import SatvisCore
import SatvisData
import StoreKit
import UIKit

/// Set up as PostHog's iOS guide has it, from the app delegate.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_: UIApplication, didFinishLaunchingWithOptions _: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        Analytics.setup(site: SatvisApp.site)
        return true
    }
}

/// Usage, counted in the web app's PostHog project: a page view with the view's
/// link whenever the view changes, as the web app's address bar makes one, so
/// the same insights count both. Nothing that identifies the user: no person
/// profiles, no autocapture, no replay, ground stations to the whole degree, and
/// the user can switch it off.
@Observable
final class Analytics {
    private static let projectToken = "phc_XNFfKcn3PKhP3EqVHvNcrEd6uxzNVFA0qFkWP5fgZK5"
    private static let host = "https://e.frcy.org"
    /// Set up only where the web app's is: a release build on satvis.space, so
    /// that development, tests and a local worker count nothing.
    private(set) static var isSetUp = false

    /// Changed by `setSharing`, so that views reading `isSharing` are told.
    private var changes = 0

    /// Whether the user lets usage be counted. Asked of PostHog when read, not
    /// kept: this is made with the session, before the app delegate sets PostHog
    /// up, and until then it answers that the user opted out.
    var isSharing: Bool {
        _ = changes
        return Self.isSetUp && !PostHogSDK.shared.isOptOut()
    }

    static func setup(site: URL) {
        #if DEBUG
            return
        #else
            guard site == WorkerClient.production else {
                return
            }
            let config = PostHogConfig(projectToken: projectToken, host: host)
            config.personProfiles = .never
            config.captureScreenViews = false
            config.surveys = false
            config.capturePushNotificationSubscriptions = false
            config.capturePushNotificationOpened = false
            config.propertiesSanitizer = GroundStationSanitizer()
            PostHogSDK.shared.setup(config)
            PostHogSDK.shared.register(["platform": "ios"])
            isSetUp = true
            Task {
                // App Store, TestFlight or Xcode, so a test build is one filter away.
                if let transaction = try? await AppTransaction.shared {
                    PostHogSDK.shared.register(["distribution": distribution(transaction.unsafePayloadValue.environment)])
                }
            }
        #endif
    }

    func setSharing(_ sharing: Bool) {
        if sharing {
            PostHogSDK.shared.optIn()
        } else {
            PostHogSDK.shared.optOut()
        }
        changes += 1
    }

    /// A view, as the web app counts one: its link, by `$current_url`.
    func pageview(_ url: URL) {
        guard Self.isSetUp else {
            return
        }
        PostHogSDK.shared.capture(
            "$pageview", properties: ["$current_url": url.absoluteString, "$host": url.host() ?? "", "$pathname": url.path()])
    }

    private static func distribution(_ environment: AppStore.Environment) -> String {
        switch environment {
        case .production: "appstore"
        case .sandbox: "testflight"
        case .xcode: "xcode"
        default: environment.rawValue
        }
    }
}

/// The web app's `sanitizePostHogEvent`: every string property holding a link
/// has its ground stations cut to the whole degree.
private final class GroundStationSanitizer: NSObject, PostHogPropertiesSanitizer {
    func sanitize(_ properties: [String: Any]) -> [String: Any] {
        properties.mapValues { value in
            (value as? String).map(sanitizedForAnalytics) ?? value
        }
    }
}
