// swift-tools-version: 6.2

import PackageDescription

// Everything the native app does that is not a view (docs/adr/0008-native-ios-app.md).
// `swift test` runs it on macOS, without a simulator.
let package = Package(
    name: "SatvisKit",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [
        .library(name: "SatvisCore", targets: ["SatvisCore"]),
        .library(name: "SatvisData", targets: ["SatvisData"]),
        .library(name: "SatvisRender", targets: ["SatvisRender"]),
    ],
    dependencies: [
        // Draco 1.5.7 prebuilt, the version the web app's draco3d decodes with: every
        // 3D model is KHR_draco_mesh_compression.
        .package(url: "https://github.com/warrenm/DracoSwift", exact: "1.5.7")
    ],
    targets: [
        // Vallado's SGP4 behind a C bridge, so Swift needs no C++ interoperability.
        .target(name: "SGP4", exclude: ["vallado/SGP4.cpp", "vallado/VENDOR.md"]),
        // Draco behind a C bridge, for the same reason.
        .target(name: "DracoBridge", dependencies: [.product(name: "DracoSwift", package: "DracoSwift")]),
        // Element sets, the group index, and the arithmetic the web app does on them.
        .target(name: "SatvisCore", dependencies: ["SGP4"], resources: [.copy("Shared")]),
        // The worker client, its disk cache, and the snapshot shipped in the app.
        .target(name: "SatvisData", dependencies: ["SatvisCore"], resources: [.copy("Snapshot")]),
        // The Metal globe. Its shaders compile at run time from Shaders/*.msl.
        .target(name: "SatvisRender", dependencies: ["SatvisCore", "DracoBridge"], resources: [.copy("Shaders"), .copy("NaturalEarthII")]),
        .testTarget(name: "SatvisCoreTests", dependencies: ["SatvisCore"], resources: [.copy("Fixtures")]),
        .testTarget(name: "SatvisDataTests", dependencies: ["SatvisData"]),
        .testTarget(name: "SatvisRenderTests", dependencies: ["SatvisRender"], exclude: ["Fixtures/README.md"], resources: [.copy("Fixtures")]),
    ],
    cxxLanguageStandard: .cxx17
)
