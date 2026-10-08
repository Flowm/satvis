#if DEBUG
    import Foundation
    import SatvisData

    /// The fixed catalog the UI tests run on, in Debug builds only: `UITestCatalog.json`,
    /// which the target's Release `EXCLUDED_SOURCE_FILE_NAMES` leaves out, holds the
    /// index and the default preset's groups as satvis.space served them on
    /// 2026-10-07, GCAT's facts included, with only the core config's groups and
    /// presets, since the plugins' stay out of the repository. The tests point the app at a worker that does not answer and ask
    /// for it with `SATVIS_TEST_CATALOG`, so they need no network and no live data.
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
            } catch {
                return nil
            }
            return store
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
