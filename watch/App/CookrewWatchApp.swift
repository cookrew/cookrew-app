import CookrewWatchUI
import SwiftUI

@main
struct CookrewWatchApp: App {
  var body: some Scene {
    WindowGroup {
      WatchRoot(address: Bundle.main.object(forInfoDictionaryKey: "CookrewBase") as? String ?? "")
    }
  }
}
