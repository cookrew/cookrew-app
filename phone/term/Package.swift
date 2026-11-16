// swift-tools-version:5.9
// Swift 5 language mode on purpose: ScreenBox.swift's assumeIsolatedCompat
// relies on it (macOS 11 has no MainActor.assumeIsolated).
// The terminal's Swift, for iOS and macOS: SwiftTerm (MIT) behind the term
// package's module and view. The Asuka CLI builds it with the apps that import
// the package, and points `asuka` at its own copy of the host.
import PackageDescription

let package = Package(
    name: "CookrewTermNative",
    platforms: [.iOS("16.0"), .macOS("11.0")],
    products: [.library(name: "CookrewTermNative", targets: ["CookrewTermNative"])],
    dependencies: [
        .package(url: "https://github.com/egoist/asuka", from: "0.1.0"),
        // Pinned: a terminal emulator's escape handling is behaviour, not an API.
        // 1.5.1 is the newest that builds without Xcode's Metal toolchain (1.12+
        // compile a shader) and runs on Asuka's macOS 11 (1.6 to 1.11 need 13).
        .package(url: "https://github.com/migueldeicaza/SwiftTerm", exact: "1.5.1"),
    ],
    targets: [
        .target(
            name: "CookrewTermNative",
            dependencies: [
                .product(name: "Asuka", package: "asuka"),
                .product(name: "SwiftTerm", package: "SwiftTerm"),
            ],
            path: "swift"
        ),
    ]
)
