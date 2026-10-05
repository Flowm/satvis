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
/// profiles, no autocapture of taps or screens, no feature flags, no replay,
/// ground stations to the whole degree, and the user can switch it off, which
/// leaves PostHog not even set up.
@Observable
final class Analytics {
    private static let projectToken = "phc_XNFfKcn3PKhP3EqVHvNcrEd6uxzNVFA0qFkWP5fgZK5"
    private static let host = "https://e.frcy.org"
    private static let sharingKey = "shareUsageData"
    /// Where usage may be counted at all: a release build on satvis.space, as
    /// the web app's, so that development, tests and a local worker count nothing.
    private(set) static var isAvailable = false
    /// Whether PostHog is set up, which it is only while the user shares.
    private(set) static var isSetUp = false

    /// Changed by `setSharing`, so that views reading `isSharing` are told.
    private var changes = 0

    /// Whether the user lets usage be counted. Kept by the app rather than by
    /// PostHog: PostHog answers only once it is set up, and for a user who said
    /// no it is not, so that nothing at all is sent.
    var isSharing: Bool {
        _ = changes
        return Self.isAvailable && Self.sharingAllowed
    }

    private static var sharingAllowed: Bool {
        UserDefaults.standard.object(forKey: sharingKey) as? Bool ?? true
    }

    static func setup(site: URL) {
        #if DEBUG
            return
        #else
            guard site == WorkerClient.production else {
                return
            }
            isAvailable = true
            if sharingAllowed {
                start(optingIn: false)
            }
        #endif
    }

    func setSharing(_ sharing: Bool) {
        guard Self.isAvailable else {
            return
        }
        UserDefaults.standard.set(sharing, forKey: Self.sharingKey)
        if sharing {
            Self.start(optingIn: true)
        } else if Self.isSetUp {
            PostHogSDK.shared.optOut()
            PostHogSDK.shared.close()
            Self.isSetUp = false
        }
        changes += 1
    }

    private static func start(optingIn: Bool) {
        guard !isSetUp else {
            return
        }
        let config = PostHogConfig(projectToken: projectToken, host: host)
        config.personProfiles = .never
        config.captureScreenViews = false
        config.surveys = false
        config.capturePushNotificationSubscriptions = false
        config.capturePushNotificationOpened = false
        // On by default, and each sends what the privacy policy says is not: a
        // flag request with the install's identifier on every launch, and the
        // place and text of rapid taps.
        config.preloadFeatureFlags = false
        config.setDefaultPersonProperties = false
        config.rageClickConfig.enabled = false
        config.captureAutocaptureElementText = false
        config.propertiesSanitizer = GroundStationSanitizer()
        PostHogSDK.shared.setup(config)
        if optingIn {
            PostHogSDK.shared.optIn()
        } else if PostHogSDK.shared.isOptOut() {
            // A no given before the app kept the choice itself, which only
            // PostHog remembered: kept, and PostHog put away again.
            UserDefaults.standard.set(false, forKey: sharingKey)
            PostHogSDK.shared.close()
            return
        }
        PostHogSDK.shared.register(["platform": "ios"])
        isSetUp = true
        Task {
            // App Store, TestFlight or Xcode, so a test build is one filter away.
            if let transaction = try? await AppTransaction.shared {
                PostHogSDK.shared.register(["distribution": distribution(transaction.unsafePayloadValue.environment)])
            }
        }
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
