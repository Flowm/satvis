import SatvisCore
import SwiftUI

/// What the globe menu is about.
enum GlobeMenuSubject: Hashable {
    /// A ground station's pin, by the station's id.
    case station(UUID)
    /// A place on the ground with no pin.
    case ground(GeoCoordinate)
}

/// The globe menu as it is open: what about, and where on the globe it points.
struct OpenGlobeMenu: Identifiable {
    let id = UUID()
    let subject: GlobeMenuSubject
    /// The heading, read as it opens: removing the station would blank it as the
    /// popover fades.
    let title: String
    /// In the globe view's points.
    let point: CGPoint

    init(subject: GlobeMenuSubject, point: CGPoint, passes: PassModel) {
        self.subject = subject
        self.point = point
        title =
            switch subject {
            case .ground(let place): Formats.coordinates(place.latitude, place.longitude)
            case .station(let id): passes.station(id)?.displayName ?? ""
            }
    }
}

/// The globe menu, as the web app's (src/components/GlobeMenu.vue). A popover,
/// since a SwiftUI `Menu` opens only from a control and `contextMenu` knows no point.
struct GlobeMenu: View {
    let menu: OpenGlobeMenu
    let session: Session
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: menu.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            Divider()
            switch menu.subject {
            case .ground(let place):
                item("Add ground station here", systemImage: "mappin.and.ellipse") { session.addStation(at: place) }
                Divider()
                item("Look up from here", systemImage: "binoculars") { session.lookUp(from: place) }
            case .station(let id):
                item("Look up from here", systemImage: "binoculars") { session.enterSky(at: id) }
                Divider()
                item("Remove ground station", systemImage: "trash", role: .destructive) { session.removeStation(id) }
            }
        }
        .fixedSize()
        .presentationCompactAdaptation(.popover)
    }

    private func item(_ title: LocalizedStringKey, systemImage: String, role: ButtonRole? = nil, action: @escaping () -> Void) -> some View {
        Button(role: role) {
            dismiss()
            action()
        } label: {
            Label(title, systemImage: systemImage)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .foregroundStyle(role == .destructive ? AnyShapeStyle(.red) : AnyShapeStyle(.primary))
    }
}
