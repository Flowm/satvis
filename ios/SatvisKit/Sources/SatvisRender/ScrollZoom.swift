import Foundation

/// A scroll wheel's or a trackpad's two-finger scroll's zoom on a Mac, as a
/// browser's wheel zooms the web app's globe: scrolling up, the content moving
/// down, brings it nearer, and as far back down returns it where it was.
public enum ScrollZoom {
    /// A trackpad reports points: a 300-point swipe is 4.5 times nearer.
    static let perPoint = 0.005
    /// A mouse wheel reports lines, one or more a notch: one is 10 % nearer.
    static let perLine = log(1.1)

    /// The pinch's scale for a scroll of `deltaY`, AppKit's `scrollingDeltaY`: in
    /// points where `precise`, as a trackpad reports it, else in lines.
    public static func scale(deltaY: Double, precise: Bool) -> Double {
        guard deltaY.isFinite else {
            return 1
        }
        return exp(deltaY * (precise ? perPoint : perLine))
    }
}
