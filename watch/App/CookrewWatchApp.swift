import CookrewWatchUI
import SwiftUI

/** A build setting that was set. */
private func info(_ key: String) -> String? {
  (Bundle.main.object(forInfoDictionaryKey: key) as? String).flatMap { $0.isEmpty ? nil : $0 }
}

@main
struct CookrewWatchApp: App {
  var body: some Scene {
    WindowGroup {
      WatchRoot(address: info("CookrewBase") ?? "", registry: info("CookrewRegistry") ?? "https://cookrew.dev")
    }
  }
}
