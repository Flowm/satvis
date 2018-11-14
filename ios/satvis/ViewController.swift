import UIKit
import WebKit

class ViewController: UIViewController {
    @IBOutlet weak var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        if let url = URL(string: "https://satvis.space/") {
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
            NSLog("NOTIFY: \(message.body)")
            guard let dict = message.body as? Dictionary<String, Any> else {
                return
            }
            guard let body = dict["message"] as? String,
                let delay = dict["delay"] as? Double,
                let date = dict["date"] as? Int else {
                return
            }
            NSLog("NOTIFY: \(date) \(body) in \(delay)s")
            AppDelegate.shared().notificationManager.triggerNotification(title: "Satvis",
                                                                         body: body,
                                                                         timeInterval: delay,
                                                                         indentifier: "\(date) \(body)")
        }
    }
}

extension WKWebView {
    override open var safeAreaInsets: UIEdgeInsets {
        return UIEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)
    }
}
