import Foundation

/// Numbers as people read them, in the device's region, as the web app's
/// `src/modules/util/formats.ts` writes them in the browser's (ADR 0015). What is not
/// for people, links, stored values and analytics, keeps its fixed form, and a date in
/// figures alone is ISO 8601 in every region.
public enum Formats {
    /// The device's locale; the tests pin en_US, which the parity fixtures are
    /// written in.
    @TaskLocal public static var locale = Locale.autoupdatingCurrent

    /// "16,819" or "16.819".
    public static func integer(_ value: Int) -> String {
        value.formatted(.number.locale(locale))
    }

    /// `toFixed(value, digits)` with the region's separators: "1,234.50" or
    /// "1.234,50".
    public static func fixed(_ value: Double, _ digits: Int) -> String {
        decimal(toFixed(value, digits))
    }

    /// A decimal written out as JavaScript writes it, every digit kept, in the
    /// region's separators: "12.6" is "12,6" in Germany. Text that is no such
    /// decimal, "NaN" say, comes back as it is.
    public static func decimal(_ text: String) -> String {
        guard text.wholeMatch(of: /-?\d+(\.\d+)?/) != nil, let value = Decimal(string: text, locale: Locale(identifier: "en_US_POSIX")) else {
            return text
        }
        let digits = text.split(separator: ".").dropFirst().first?.count ?? 0
        let formatted = value.formatted(.number.locale(locale).precision(.fractionLength(digits)))
        // Decimal has no negative zero, which toFixed writes as "-0.00".
        return text.hasPrefix("-") && value.isZero ? "-\(formatted)" : formatted
    }

    /// "48.14°, 11.58°": a place to two decimals, as a station without a name is shown.
    public static func coordinates(_ latitude: Double, _ longitude: Double) -> String {
        "\(fixed(latitude, 2))°, \(fixed(longitude, 2))°"
    }

    /// A number as JavaScript's `String(value)` writes it, every digit kept, in the
    /// region's separators.
    public static func number(_ value: Double) -> String {
        decimal(javaScriptString(value))
    }

    /// "2,857.123": up to three decimals, the rest rounded half away from zero, as
    /// `toLocaleString` writes a number.
    public static func measure(_ value: Double) -> String {
        value.formatted(.number.locale(locale).precision(.fractionLength(0...3)).rounded(rule: .toNearestOrAwayFromZero))
    }
}
