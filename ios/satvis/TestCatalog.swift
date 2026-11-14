#if DEBUG
    import CoreGraphics
    import Foundation
    import ImageIO
    import SatvisCore
    import SatvisData
    import UniformTypeIdentifiers

    /// The fixed catalog the UI tests run on, in Debug builds only: `UITestCatalog.json`,
    /// which the target's Release `EXCLUDED_SOURCE_FILE_NAMES` leaves out, holds the
    /// index and the default preset's groups as satvis.space served them on
    /// 2026-10-07, GCAT's facts included, and METOP-C's, GOES 19's, Meteosat-12's and
    /// INSAT-3D's instruments as CEOS lists them since (ADR 0018), the first three with
    /// their imagery as the imagery manifest gives it (ADR 0019), GOES 19 and Meteosat-12
    /// with the geostationary mosaic's composite as well, and TERRA, whose two
    /// imagers have a layer each, as satvis.space served it on 2026-11-13; with only the
    /// core config's groups and presets, since the plugins' stay out of the repository,
    /// and the default preset's featured bookmarks and benchmark scenes as the core
    /// config has them since. The tests point the app at a worker that does not answer
    /// and ask for it with `SATVIS_TEST_CATALOG`, so they need no network and no live data.
    /// Each star map is there too, as black faces: the real ones are fetched and
    /// kept, and a test that found one kept by an earlier run passed only there.
    enum TestCatalog {
        /// Whether the launch asked for the test catalog.
        nonisolated static let isRequested = ProcessInfo.processInfo.environment["SATVIS_TEST_CATALOG"] != nil

        /// The catalog unpacked into a store's layout, or nil unless asked for.
        static func store() -> PayloadStore? {
            guard isRequested,
                let url = Bundle.main.url(forResource: "UITestCatalog", withExtension: "json"),
                let catalog = try? JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any],
                let index = catalog["index"], let groups = catalog["groups"] as? [String: Any]
            else {
                return nil
            }
            let store = PayloadStore(directory: URL.temporaryDirectory.appending(path: "UITestCatalog", directoryHint: .isDirectory))
            do {
                try store.write(.index, data: JSONSerialization.data(withJSONObject: index), etag: nil, confirmed: .distantPast)
                for (name, records) in groups {
                    try store.write(.group(name), data: JSONSerialization.data(withJSONObject: records), etag: nil, confirmed: .distantPast)
                }
                if let face = blackFace() {
                    for map in [StarMapName.deepStar1K, .deepStar2K] {
                        for path in GroupRepository.starMapFaces(map) {
                            try store.write(.file(path), data: face, etag: nil, confirmed: .distantPast)
                        }
                    }
                }
            } catch {
                return nil
            }
            return store
        }

        /// A star map's face for the tests: a black square, as a PNG.
        private static func blackFace() -> Data? {
            let side = 4
            guard
                let context = CGContext(
                    data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue),
                let image = context.makeImage()
            else {
                return nil
            }
            let data = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
                return nil
            }
            CGImageDestinationAddImage(destination, image, nil)
            return CGImageDestinationFinalize(destination) ? data as Data : nil
        }

        /// A kept store of its own for each launch on the test catalog, so a test reads
        /// the catalog and not what an earlier run kept from a worker, which the
        /// repository reads first; nil unless asked for.
        static func keptStore() -> PayloadStore? {
            guard isRequested else {
                return nil
            }
            return PayloadStore(directory: URL.temporaryDirectory.appending(path: "UITestKept-\(UUID())", directoryHint: .isDirectory))
        }

        /// A bookmark storage of its own for each launch on the test catalog, so a
        /// test starts with no bookmarks whatever an earlier run saved; nil unless asked for.
        static func bookmarkStorage() -> BookmarkStorage? {
            guard isRequested else {
                return nil
            }
            return BookmarkStorage(directory: URL.temporaryDirectory.appending(path: "UITestBookmarks-\(UUID())", directoryHint: .isDirectory))
        }

        /// Defaults of their own for the stations, emptied as each launch on the test
        /// catalog starts, so a test starts with none and leaves none in the app's
        /// own list, as a run on a device did; nil unless asked for. Unchecked:
        /// UserDefaults is thread-safe, as its documentation says, but not Sendable.
        nonisolated(unsafe) static let stationDefaults: UserDefaults? = {
            guard isRequested else {
                return nil
            }
            let suite = "UITestStations"
            UserDefaults().removePersistentDomain(forName: suite)
            return UserDefaults(suiteName: suite)
        }()
    }
#endif
