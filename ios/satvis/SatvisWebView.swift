import SwiftUI
import WebKit

struct SatvisWebView: UIViewRepresentable {
    let url: URL
    let notificationManager: NotificationManager

    func makeCoordinator() -> Coordinator {
        Coordinator(notificationManager: notificationManager)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.userContentController.add(context.coordinator, name: "iosNotify")

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.isOpaque = false
        // The page lays itself out around the safe area (viewport-fit=cover)
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

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
                    NSLog("NOTIFY: \(date) \"\(body)\" in \(delay)s")
                } else {
                    NSLog("NOTIFY: \(date) \"\(body)\" in \(delay)s not scheduled: no permission or notification limit reached")
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
