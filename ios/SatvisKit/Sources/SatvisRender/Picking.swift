import CoreGraphics

/// How near a tap is to a satellite drawn on the screen, as its point and its
/// label: in points, nil out of reach. The nearest satellite is the one picked.
enum Picking {
    /// A fingertip around a point.
    static let pointReach = 24.0
    /// Around a label, whose own extent is target enough.
    static let labelReach = 8.0
    /// What a label gives away to a point: a tap on a point that a neighbour's
    /// label overlaps picks the point.
    static let labelPenalty = 4.0

    /// `label` is where the name is drawn, beside the point. A tap inside it
    /// scores by how far off its middle line it is, so that of two overlapping
    /// labels the one it is centred on wins.
    /// `reach` widens the point's to cover a 3D model drawn there.
    static func score(of tap: CGPoint, point: CGPoint, label: CGRect?, reach: Double = pointReach) -> Double? {
        var best: Double?
        let pointDistance = hypot(tap.x - point.x, tap.y - point.y)
        if pointDistance < max(reach, pointReach) {
            best = pointDistance
        }
        if let label {
            let dx = max(label.minX - tap.x, 0, tap.x - label.maxX)
            let dy = max(label.minY - tap.y, 0, tap.y - label.maxY)
            let outside = hypot(dx, dy)
            if outside < labelReach {
                let offMiddle = label.height > 0 ? abs(tap.y - label.midY) / label.height : 0
                best = min(best ?? .infinity, labelPenalty + outside + offMiddle)
            }
        }
        return best
    }
}
