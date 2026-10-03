import UIKit
import WebKit

class ViewController: UIViewController {
    @IBOutlet weak var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        // The page lays itself out around the safe area (viewport-fit=cover)
        webView.scrollView.contentInsetAdjustmentBehavior = .never

        let urlString = ProcessInfo.processInfo.environment["URL"] ?? "https://satvis.space/"
        if let url = URL(string: urlString) {
            webView.configuration.userContentController.add(self, name: "iosNotify")
            webView.load(URLRequest(url: url))
        }
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        return .lightContent
    }
}

extension ViewController: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "iosNotify" {
            guard let dict = message.body as? Dictionary<String, Any> else {
                return
            }
            guard let body = dict["message"] as? String,
                let delay = dict["delay"] as? Double,
                let date = dict["date"] as? Int else {
                return
            }
            guard let notificationManager = AppDelegate.shared().notificationManager else {
                return
            }
            let request = notificationManager.createNotificationRequest(title: "Satvis",
                                                                        body: body,
                                                                        timeInterval: delay,
                                                                        identifier: "\(date) \(body)")
            Task {
                if await notificationManager.scheduleRequestChronological(request: request) {
                    NSLog("NOTIFY: \(date) \"\(body)\" in \(delay)s")
                } else {
                    NSLog("NOTIFY: \(date) \"\(body)\" in \(delay)s ignored due to notification limit")
                }
            }
        }
    }
}

extension ViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url, openExternally(url) {
            return .cancel
        }
        return .allow
    }
}

extension ViewController: WKUIDelegate {
    // Links that open a new window, e.g. via window.open
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            _ = openExternally(url)
        }
        return nil
    }
}

extension ViewController {
    func openExternally(_ url: URL) -> Bool {
        guard UIApplication.shared.canOpenURL(url) else {
            return false
        }
        UIApplication.shared.open(url)
        return true
    }
}
