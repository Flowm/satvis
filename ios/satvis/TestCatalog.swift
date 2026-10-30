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
    /// 2026-10-07, GCAT's facts included, with only the core config's groups and
    /// presets, since the plugins' stay out of the repository. The tests point the app at a worker that does not answer and ask
    /// for it with `SATVIS_TEST_CATALOG`, so they need no network and no live data.
    /// Each star map is there too, as black faces: the real ones are fetched and
    /// kept, and a test that found one kept by an earlier run passed only there.
    enum TestCatalog {
        /// The catalog unpacked into a store's layout, or nil unless asked for.
        static func store() -> PayloadStore? {
            guard ProcessInfo.processInfo.environment["SATVIS_TEST_CATALOG"] != nil,
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

        /// A bookmark storage of its own for each launch on the test catalog, so a
        /// test starts with no bookmarks whatever an earlier run saved; nil unless asked for.
        static func bookmarkStorage() -> BookmarkStorage? {
            guard ProcessInfo.processInfo.environment["SATVIS_TEST_CATALOG"] != nil else {
                return nil
            }
            return BookmarkStorage(directory: URL.temporaryDirectory.appending(path: "UITestBookmarks-\(UUID())", directoryHint: .isDirectory))
        }
    }
#endif
