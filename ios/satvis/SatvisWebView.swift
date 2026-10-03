import SwiftUI
import WebKit
import os

nonisolated private let log = Logger(subsystem: "org.frcy.app.satvis", category: "webview")

struct SatvisWebView: UIViewRepresentable {
    let url: URL
    let notificationManager: NotificationManager

    func makeCoordinator() -> Coordinator {
        Coordinator(notificationManager: notificationManager)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.mediaTypesRequiringUserActionForPlayback = []
        // Service workers, and with them the page's offline cache, run only for the
        // WKAppBoundDomains in Info.plist, and only in a web view limited to them.
        // Other hosts, e.g. a deploy preview, load unlimited and without them.
        configuration.limitsNavigationsToAppBoundDomains = Self.isAppBound(url)
        // Appended to WebKit's "Mobile/15E148", so the page and analytics can tell the app from Safari
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        configuration.applicationNameForUserAgent = [configuration.applicationNameForUserAgent, "SatvisApp/\(version)"].compactMap { $0 }.joined(separator: " ")
        configuration.userContentController.add(context.coordinator, name: "iosNotify")

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.isOpaque = false
        #if DEBUG
            // Lets Safari's Web Inspector attach to the page
            webView.isInspectable = true
        #endif
        // The page lays itself out around the safe area (viewport-fit=cover)
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    private static func isAppBound(_ url: URL) -> Bool {
        let domains = Bundle.main.object(forInfoDictionaryKey: "WKAppBoundDomains") as? [String] ?? []
        return url.host().map(domains.contains) ?? false
    }

    class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
        let notificationManager: NotificationManager

        init(notificationManager: NotificationManager) {
            self.notificationManager = notificationManager
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "iosNotify",
                let dict = message.body as? [String: Any],
                let body = dict["message"] as? String,
                let delay = dict["delay"] as? Double,
                let date = dict["date"] as? Int
            else {
                return
            }
            let request = notificationManager.createNotificationRequest(
                title: "Satvis",
                body: body,
                timeInterval: delay,
                identifier: "\(date) \(body)")
            Task {
                if await notificationManager.scheduleRequestChronological(request: request) {
                    log.notice("Notify \(date) \"\(body, privacy: .public)\" in \(delay, format: .fixed(precision: 1))s")
                } else {
                    log.notice("Notify \(date) \"\(body, privacy: .public)\" in \(delay, format: .fixed(precision: 1))s not scheduled: no permission or notification limit reached")
                }
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url, openExternally(url) {
                return .cancel
            }
            return .allow
        }

        // Links that open a new window, e.g. via window.open
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures)
            -> WKWebView?
        {
            if let url = navigationAction.request.url {
                _ = openExternally(url)
            }
            return nil
        }

        private func openExternally(_ url: URL) -> Bool {
            guard UIApplication.shared.canOpenURL(url) else {
                return false
            }
            UIApplication.shared.open(url)
            return true
        }
    }
}
