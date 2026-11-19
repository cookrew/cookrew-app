// Seatbelt probe: does WKWebView's networking process fetch a URL for a confined caller?
// Usage: webkit-probe <url>
// Prints exactly one line: LOADED <body text> | FAIL <code> | TIMEOUT
import AppKit
import WebKit

final class Navigation: NSObject, WKNavigationDelegate {
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    webView.evaluateJavaScript("document.body.innerText") { value, _ in
      print("LOADED \(value ?? "")")
      exit(0)
    }
  }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    print("FAIL \((error as NSError).code)")
    exit(2)
  }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    print("FAIL \((error as NSError).code)")
    exit(2)
  }
}

guard CommandLine.arguments.count == 2, let url = URL(string: CommandLine.arguments[1]) else {
  print("USAGE")
  exit(64)
}
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let navigation = Navigation()
let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 10, height: 10))
view.navigationDelegate = navigation
view.load(URLRequest(url: url))
DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
  print("TIMEOUT")
  exit(3)
}
app.run()
