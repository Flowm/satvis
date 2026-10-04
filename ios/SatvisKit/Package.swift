// swift-tools-version: 6.2

import PackageDescription

// Everything the native app does that is not a view (docs/adr/0007-native-ios-app.md).
// `swift test` runs it on macOS, without a simulator.
let package = Package(
    name: "SatvisKit",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [
        .library(name: "SatvisCore", targets: ["SatvisCore"]),
        .library(name: "SatvisData", targets: ["SatvisData"]),
    ],
    targets: [
        // Element sets, the group index, and the arithmetic the web app does on them.
        .target(name: "SatvisCore"),
        // The worker client, its disk cache, and the snapshot shipped in the app.
        .target(name: "SatvisData", dependencies: ["SatvisCore"], resources: [.copy("Snapshot")]),
        .testTarget(name: "SatvisCoreTests", dependencies: ["SatvisCore"], resources: [.copy("Fixtures")]),
        .testTarget(name: "SatvisDataTests", dependencies: ["SatvisData"]),
    ]
)
