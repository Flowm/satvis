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
        .library(name: "SatvisRender", targets: ["SatvisRender"]),
    ],
    targets: [
        // Vallado's SGP4 behind a C bridge, so Swift needs no C++ interoperability.
        .target(name: "SGP4", exclude: ["vallado/SGP4.cpp", "vallado/VENDOR.md"]),
        // Element sets, the group index, and the arithmetic the web app does on them.
        .target(name: "SatvisCore", dependencies: ["SGP4"]),
        // The worker client, its disk cache, and the snapshot shipped in the app.
        .target(name: "SatvisData", dependencies: ["SatvisCore"], resources: [.copy("Snapshot")]),
        // The Metal globe. Its shaders compile at run time from Shaders/*.msl.
        .target(name: "SatvisRender", dependencies: ["SatvisCore"], resources: [.copy("Shaders"), .copy("NaturalEarthII")]),
        .testTarget(name: "SatvisCoreTests", dependencies: ["SatvisCore"], resources: [.copy("Fixtures")]),
        .testTarget(name: "SatvisDataTests", dependencies: ["SatvisData"]),
        .testTarget(name: "SatvisRenderTests", dependencies: ["SatvisRender"]),
    ],
    cxxLanguageStandard: .cxx17
)
