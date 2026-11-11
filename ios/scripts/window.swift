// Prints the number of the largest window a process shows, for screencapture -l,
// then its width and height in points, waiting up to a minute for it to appear.
// Numbers, owners and bounds need no Screen Recording permission; titles would.
//
//   swift scripts/window.swift <pid>
import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 2, let pid = Int(CommandLine.arguments[1]) else {
    FileHandle.standardError.write("usage: window.swift <pid>\n".data(using: .utf8)!)
    exit(2)
}
for _ in 0..<60 {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let shown = windows.compactMap { window -> (number: Int, size: CGSize)? in
        guard window[kCGWindowOwnerPID as String] as? Int == pid, window[kCGWindowLayer as String] as? Int == 0,
            let number = window[kCGWindowNumber as String] as? Int,
            let bounds = (window[kCGWindowBounds as String] as? NSDictionary).flatMap({ CGRect(dictionaryRepresentation: $0) })
        else { return nil }
        return (number, bounds.size)
    }
    if let largest = shown.max(by: { $0.size.width * $0.size.height < $1.size.width * $1.size.height }) {
        print(largest.number, Int(largest.size.width), Int(largest.size.height))
        exit(0)
    }
    sleep(1)
}
FileHandle.standardError.write("Process \(pid) shows no window\n".data(using: .utf8)!)
exit(1)
