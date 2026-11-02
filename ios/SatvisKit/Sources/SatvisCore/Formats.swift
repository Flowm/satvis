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

    /// "Sun, Oct 25" or "Sun 25 Oct": the clock deck's day, in UTC, in the region's
    /// order of day and month, as the web app writes it. Punctuation is the comma
    /// English writes before a month, none of the region's: Foundation's own is
    /// "Sun 25. Oct" for en_DE, the browser's "Sun, 25 Oct".
    public static func weekdayDate(_ date: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        let parts = calendar.dateComponents([.weekday, .day, .month], from: date)
        let day = String(format: "%02d", parts.day!)
        let month = months[parts.month! - 1]
        // A pattern's quoted literals could hold either letter.
        let pattern = (DateFormatter.dateFormat(fromTemplate: "ddMMM", options: 0, locale: locale) ?? "").replacing(/'[^']*'/, with: "")
        let dayFirst = (pattern.firstIndex(of: "d") ?? pattern.endIndex) < (pattern.firstIndex(of: "M") ?? pattern.endIndex)
        return "\(weekdays[parts.weekday! - 1])\(dayFirst ? " \(day) \(month)" : ", \(month) \(day)")"
    }

    /// The same in every region, as the web app's: the browser's locale data has
    /// "Sept" for en-GB and "June" for en-AU, Apple's has neither.
    private static let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    /// See `weekdays`.
    private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
}
