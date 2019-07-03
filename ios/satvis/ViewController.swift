import UIKit
import WebKit

class ViewController: UIViewController {
    @IBOutlet weak var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        let urlString = ProcessInfo.processInfo.environment["URL"] ?? "https://satvis.space/"
        if let url = URL(string: urlString) {
            let request = URLRequest(url: url)
            webView.load(request)
            webView.configuration.userContentController.add(self, name: "iosNotify")
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
                                                                        indentifier: "\(date) \(body)")
            if (notificationManager.scheduleRequestChronological(request: request)) {
                NSLog("NOTIFY: \(date) \"\(body)\" in \(delay)s")
            } else {
                NSLog("NOTIFY: \(date) \"\(body)\" in \(delay)s ignored due to notification limit")

            }
        }
    }
}

extension WKWebView {
    override open var safeAreaInsets: UIEdgeInsets {
        return UIEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)
    }
}
