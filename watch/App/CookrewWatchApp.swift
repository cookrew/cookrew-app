import CookrewWatchUI
import SwiftUI

/** A build setting that was set. */
private func info(_ key: String) -> String? {
  (Bundle.main.object(forInfoDictionaryKey: key) as? String).flatMap { $0.isEmpty ? nil : $0 }
}

@main
struct CookrewWatchApp: App {
  private let registry = info("CookrewRegistry") ?? "https://api.cookrew.dev"

  var body: some Scene {
    WindowGroup {
      WatchRoot(address: info("CookrewBase") ?? "", registry: registry)
    }
    // Every quarter hour or so, as watchOS allows: agents that started waiting or finished become alerts.
    .backgroundTask(.appRefresh(StatusAlerts.refresh)) { [registry] in
      await StatusAlerts.check(registry: registry)
    }
  }
}
