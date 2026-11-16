// swift-tools-version:5.9
// The snap package's Swift: the Mac only.
import PackageDescription

let package = Package(
    name: "CookrewSnapNative",
    platforms: [.macOS("11.0")],
    products: [.library(name: "CookrewSnapNative", targets: ["CookrewSnapNative"])],
    dependencies: [
        .package(url: "https://github.com/egoist/asuka", from: "0.1.0"),
    ],
    targets: [
        .target(name: "CookrewSnapNative", dependencies: [.product(name: "Asuka", package: "asuka")], path: "swift"),
    ]
)
