import Foundation

/// The web app's pixel ratio ladder (src/config/rendering.ts): what a `pixelratio`
/// value draws at on a screen, and the rungs the Graphics panel offers.
public enum PixelRatioLadder {
    /// The ratios a link may name besides `native`, the web app's `PIXEL_RATIO_RANGE`.
    public static let range = 1.0...4.0

    /// Below it the halfway rung saves too little to offer, as on the web.
    public static let midFrom = 2.0

    /// Halfway from 1 to the screen's scale, to a quarter so its label stays short:
    /// 1.5 at 2, 2 at 3.
    public static func mid(screen: Double) -> Double {
        min((((1 + screen) / 2) * 4).rounded() / 4, range.upperBound)
    }

    /// As JavaScript's `String(number)` writes a ratio: 2, not 2.0.
    static func written(_ value: Double) -> String {
        value == value.rounded() && abs(value) < 1e15 ? String(Int(value)) : String(value)
    }

    /// Drawable pixels per point for a `pixelratio` value; the screen's own for one
    /// the app cannot read, and 1 for a nonsense screen scale.
    public static func value(_ ratio: String, screen: Double) -> Double {
        guard screen > 0 else { return 1 }
        return ratio == "native" ? screen : Double(ratio) ?? screen
    }

    /// 1, halfway from a scale of 2, then `native`: only savings.
    public static func rungs(screen: Double) -> [String] {
        var rungs: [String] = []
        if screen > 1 { rungs.append("1") }
        if screen >= midFrom { rungs.append(written(mid(screen: screen))) }
        rungs.append("native")
        return rungs
    }

    /// The offered rung drawing at the same ratio as `ratio`, as `native` for a link's
    /// `2` on a 2x screen; none when the panel offers no such rung.
    public static func offered(_ ratio: String, screen: Double) -> String? {
        let target = value(ratio, screen: screen)
        return rungs(screen: screen).first { value($0, screen: screen) == target }
    }
}
