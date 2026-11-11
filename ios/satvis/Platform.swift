import Foundation
import SatvisRender
import SwiftUI

/// What the app asks of the system where an iPhone and a Mac answer it apart.
enum Platform {
    /// Whether the user asked for less motion.
    static var reducesMotion: Bool {
        #if os(iOS)
            UIAccessibility.isReduceMotionEnabled
        #else
            NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        #endif
    }

    /// The device's model, "iPhone18,1" or "Mac16,7": `utsname` names only the
    /// processor on a Mac.
    static var modelIdentifier: String {
        #if os(macOS)
            var size = 0
            sysctlbyname("hw.model", nil, &size, nil, 0)
            var model = [CChar](repeating: 0, count: size)
            sysctlbyname("hw.model", &model, &size, nil, 0)
            return String(decoding: model.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
        #else
            var system = utsname()
            uname(&system)
            return withUnsafeBytes(of: system.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
        #endif
    }

    /// "iPhone", "iPad" or "Mac".
    static var deviceKind: String {
        #if os(iOS)
            UIDevice.current.model
        #else
            "Mac"
        #endif
    }

    /// The system's version, "26.1".
    static var systemVersion: String {
        let version = ProcessInfo.processInfo.operatingSystemVersion
        return version.patchVersion == 0
            ? "\(version.majorVersion).\(version.minorVersion)" : "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
    }

    /// The screen the globe is on: its pixels and pixels a point.
    static var screen: (pixels: CGSize, scale: CGFloat)? {
        #if os(iOS)
            (UIApplication.shared.connectedScenes.first as? UIWindowScene).map { scene in
                (scene.screen.nativeBounds.size, scene.screen.nativeScale)
            }
        #else
            (GlobeRenderer.window?.screen ?? NSScreen.main).map { screen in
                let scale = screen.backingScaleFactor
                return (CGSize(width: screen.frame.width * scale, height: screen.frame.height * scale), scale)
            }
        #endif
    }

    /// The app's icon as the home screen or the Dock shows it.
    static var appIcon: Image? {
        #if os(iOS)
            // The flattened icon Xcode writes for the home screen.
            UIImage(named: "AppIcon60x60").map(Image.init(uiImage:))
        #else
            Image(nsImage: NSApplication.shared.applicationIconImage)
        #endif
    }

    /// Each time the system runs short of memory: UIKit's memory warning, or a
    /// Mac's memory pressure, which has no such notification.
    static func memoryWarnings() -> AsyncStream<Void> {
        AsyncStream { continuation in
            #if os(iOS)
                let watching = Task {
                    for await _ in NotificationCenter.default.notifications(named: UIApplication.didReceiveMemoryWarningNotification) {
                        continuation.yield()
                    }
                }
                continuation.onTermination = { _ in watching.cancel() }
            #else
                let source = DispatchSource.makeMemoryPressureSource(eventMask: [.warning, .critical], queue: .main)
                source.setEventHandler { continuation.yield() }
                continuation.onTermination = { _ in source.cancel() }
                source.activate()
            #endif
        }
    }

    /// Puts `text` on the clipboard.
    static func copy(_ text: String) {
        #if os(iOS)
            UIPasteboard.general.string = text
        #else
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        #endif
    }
}

extension Image {
    /// The picture encoded in `data`, a JPEG or PNG; nil where it does not decode.
    init?(encoded data: Data) {
        #if os(iOS)
            guard let image = UIImage(data: data) else {
                return nil
            }
            self.init(uiImage: image)
        #else
            guard let image = NSImage(data: data) else {
                return nil
            }
            self.init(nsImage: image)
        #endif
    }
}

extension View {
    /// Digits and a sign on an iPhone's keyboard; a Mac's has them all.
    func signedNumberKeyboard() -> some View {
        #if os(macOS)
            self
        #else
            keyboardType(.numbersAndPunctuation)
        #endif
    }

    /// Typed as it is, with no capital letter put first; a Mac puts none.
    func noAutocapitalization() -> some View {
        #if os(macOS)
            self
        #else
            textInputAutocapitalization(.never)
        #endif
    }
}

extension ToolbarItemPlacement {
    /// The title's place in the bar.
    static var barTitle: ToolbarItemPlacement {
        #if os(macOS)
            .principal
        #else
            .title
        #endif
    }
}
