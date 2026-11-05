// swift-tools-version:5.9
import PackageDescription

// The watch app's whole code, as a package, so most of it builds, tests and
// renders on a Mac with no watchOS SDK (see project.yml for the app itself):
//   swift test                    the logic
//   swift run watch-shots <dir>   every screen, drawn at watch size
let package = Package(
  name: "CookrewWatch",
  platforms: [.watchOS(.v10), .macOS(.v14)],
  products: [.library(name: "CookrewWatchUI", targets: ["CookrewWatchUI"])],
  targets: [
    .target(name: "CookrewCore"),
    .target(name: "CookrewWatchUI", dependencies: ["CookrewCore"]),
    .executableTarget(name: "watch-shots", dependencies: ["CookrewWatchUI", "CookrewCore"]),
    .testTarget(name: "CookrewCoreTests", dependencies: ["CookrewCore"])
  ]
)
