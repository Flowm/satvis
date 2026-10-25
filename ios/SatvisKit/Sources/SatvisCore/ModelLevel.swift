/// Which of a model's files is drawn at a size (src/config/modelLevels.ts): 0 for the
/// model's file and `i + 1` for copy `i`.
public enum ModelLevel {
    /// A model drawn by a copy goes back to a coarser copy only below this share of
    /// that copy's maxPoints, so a model at the boundary does not flicker.
    public static let hysteresis = 0.8

    /// The level to draw, from the on-screen diameter in points of the level drawn
    /// now, `current`. A copy holds the model up to its maxPoints; a coarser one takes
    /// over below `hysteresis` of its own.
    public static func level(diameter: Double, current: Int, lods: [ModelLod]) -> Int {
        var level = min(max(current, 0), lods.count)
        while level > 0, diameter > lods[level - 1].maxPoints {
            level -= 1
        }
        while level < lods.count, diameter < hysteresis * lods[level].maxPoints {
            level += 1
        }
        return level
    }
}
