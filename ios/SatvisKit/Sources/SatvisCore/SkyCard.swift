import Foundation

/// What the sky view's lock card says of a satellite, as the web app's
/// (src/modules/skyCard.ts): whole numbers grouped as en-US, whatever the region,
/// as its fixed width is sized for those digits (ADR 0015).
public enum SkyCard {
    /// Where to look, for the eye and for VoiceOver: "192° SSW · 47° up · 1,540 km
    /// away". Degrees, and kilometres for the range.
    public static func position(azimuth: Double, elevation: Double, range: Double) -> (text: String, spoken: String) {
        let bearing = "\(((whole(azimuth) % 360) + 360) % 360)° \(compassPoint(azimuth))"
        let away = "\(grouped(whole(range))) km away"
        return ("\(bearing) · \(whole(elevation))° up · \(away)", "Azimuth \(bearing), elevation \(whole(elevation))°, \(away)")
    }

    /// JavaScript's `Math.round`: a tie goes up, not away from zero.
    private static func whole(_ value: Double) -> Int {
        Int((value + 0.5).rounded(.down))
    }

    private static func grouped(_ value: Int) -> String {
        value.formatted(.number.locale(Locale(identifier: "en_US")))
    }
}
