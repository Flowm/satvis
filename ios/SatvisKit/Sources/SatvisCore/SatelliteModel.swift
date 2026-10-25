/// A satellite's 3D model (ADR 0007): its file under the site's /data/models/, and
/// the copies drawn while it is small, most detailed first.
public struct SatelliteModel: Sendable, Hashable {
    public var file: String
    public var lods: [ModelLod]

    public init(file: String, lods: [ModelLod] = []) {
        self.file = file
        self.lods = lods
    }

    /// Its levels' files: the model's own, then its copies'.
    public var files: [String] {
        [file] + lods.map(\.file)
    }

    /// A record's `model`, else the `modelFile` a payload from before `model` carries
    /// alone; nil without either. Copies that do not parse are left out whole, so the
    /// file is drawn.
    public init?(metadata: [String: JSONValue]) {
        if case .object(let model) = metadata["model"], let file = model["file"]?.string {
            let lods = model["lods"]?.array?.map(ModelLod.init(json:))
            self.init(file: file, lods: lods.flatMap { $0.contains(nil) ? nil : $0.compactMap(\.self) } ?? [])
        } else if let file = metadata["modelFile"]?.string {
            self.init(file: file)
        } else {
            return nil
        }
    }
}

/// A lower-detail copy of a satellite's 3D model, drawn while the model's bounding
/// sphere spans at most `maxPoints` on screen.
public struct ModelLod: Sendable, Hashable {
    /// Under the site's /data/models/, as the model's file is.
    public var file: String
    public var maxPoints: Double

    public init(file: String, maxPoints: Double) {
        self.file = file
        self.maxPoints = maxPoints
    }

    init?(json: JSONValue) {
        guard case .object(let fields) = json, let file = fields["file"]?.string, let maxPoints = fields["maxPoints"]?.number else {
            return nil
        }
        self.init(file: file, maxPoints: maxPoints)
    }
}

extension GPRecord {
    /// Its 3D model, if a model manifest gives it one.
    public var model: SatelliteModel? {
        SatelliteModel(metadata: metadata)
    }
}
