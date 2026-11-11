import Foundation

extension FileManager {
    /// The app's own folder in the user's `directory`, Application Support or
    /// Caches. On iOS, and in a Mac's sandbox, the system's folder is the app's
    /// alone; a Mac build run without the sandbox, as from Xcode, gets the user's
    /// own, which every app shares, so it keeps to a folder named by its bundle id.
    func appFolder(_ directory: SearchPathDirectory) throws -> URL {
        let base = try url(for: directory, in: .userDomainMask, appropriateFor: nil, create: true)
        #if os(macOS)
            return base.appending(path: Bundle.main.bundleIdentifier ?? "org.frcy.app.satvis", directoryHint: .isDirectory)
        #else
            return base
        #endif
    }
}
