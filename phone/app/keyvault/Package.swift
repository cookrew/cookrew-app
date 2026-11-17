// swift-tools-version:5.9
// The keyvault package's Swift, for iOS and macOS: the Asuka CLI builds it
// with the apps that import the package. Its dependencies (Swift
// packages) go here, as any package's.
import PackageDescription

let package = Package(
    name: "KeyvaultNative",
    platforms: [.iOS("16.0"), .macOS("11.0")],
    products: [.library(name: "KeyvaultNative", targets: ["KeyvaultNative"])],
    dependencies: [
        .package(url: "https://github.com/egoist/asuka", from: "0.1.0"),
    ],
    targets: [
        .target(name: "KeyvaultNative", dependencies: [.product(name: "Asuka", package: "asuka")], path: "swift"),
    ]
)
