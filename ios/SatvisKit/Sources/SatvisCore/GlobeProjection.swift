/// How the globe is drawn (CONTEXT.md, View mode): as a globe, or flat as the web
/// app's 2D, a map in plate carrée. The sky view is drawn in 3D whatever this is,
/// and keeps it as the projection it goes back to (ADR 0003). Its raw value is the
/// `scene` parameter's; Columbus is the web app's alone (ADR 0009).
public enum GlobeProjection: String, Sendable, CaseIterable {
    case threeD = "3D"
    case twoD = "2D"
}
