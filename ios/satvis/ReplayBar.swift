import SatvisCore
import SwiftUI

/// An overpass replay's controls, over the clock while one is on (ADR 0023): the satellite,
/// the station and the overpass the clock is at, the camera, the steps either side, and
/// the way out. The web app's ReplayBar.
struct ReplayBar: View {
    let session: Session

    var body: some View {
        if let active = session.replay.active {
            TimelineView(.periodic(from: .now, by: 1)) { _ in
                bar(active, place: place(active, at: session.clock.now()))
            }
        }
    }

    /// The bar over `active`, its steps either side of `place`.
    private func bar(_ active: OverpassReplayModel.Active, place: OverpassReplay.Place<RecordedOverpass>) -> some View {
        let title = "Replaying the granules \(active.on.satellite)'s \(active.on.instrument) sensed over \(active.station)"
        return HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text(active.on.satellite)
                    .font(.footnote.weight(.semibold))
                Text(place.current.map { "\(active.station) · \($0.overpass.minuteLabel) UTC" } ?? active.station)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .lineLimit(1)
            .accessibilityElement(children: .combine)
            .accessibilityHint(title)
            .help(title)
            Spacer(minLength: 0)
            HStack(spacing: 1) {
                ForEach(ReplayCamera.allCases) { camera in
                    let isOn = session.replay.camera == camera
                    button("\(camera.label) camera", symbol: camera.symbol, isOn: isOn, help: camera.title) {
                        session.replay.watch(from: camera)
                    }
                    .accessibilityAddTraits(isOn ? .isSelected : [])
                }
            }
            .padding(.horizontal, 4)
            .overlay(alignment: .leading) { Divider() }
            .overlay(alignment: .trailing) { Divider() }
            button("Previous overpass", symbol: "chevron.left", help: stepTitle(place.previous, "Previous")) {
                place.previous.map(session.replay.step)
            }
            .disabled(place.previous == nil)
            button("Next overpass", symbol: "chevron.right", help: stepTitle(place.next, "Next")) {
                place.next.map(session.replay.step)
            }
            .disabled(place.next == nil)
            button("Exit replay", symbol: "xmark", help: "Take the granules off and go back to now") {
                session.replay.stop(returnView: true)
                session.clock.goLive()
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, 4)
        .padding(.vertical, 4)
        .frame(minWidth: 260, maxWidth: 460)
        .background(Color.panelSurface, in: .rect(cornerRadius: 14))
        .overlay {
            RoundedRectangle(cornerRadius: 14).strokeBorder(Color.white.opacity(0.08))
        }
        .padding(.horizontal, 8)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Overpass replay")
    }

    /// Where the clock is among the replay's steps; of steps replayed at once, the replay's own.
    private func place(_ active: OverpassReplayModel.Active, at time: Double) -> OverpassReplay.Place<RecordedOverpass> {
        OverpassReplay.place(
            active.steps, time: time, start: { $0.overpass.start - OverpassReplay.leadMs }, end: \.overpass.end,
            on: { $0.layer.token == active.on.layer.token && $0.station == active.station })
    }

    /// A step button's help.
    private func stepTitle(_ to: RecordedOverpass?, _ which: String) -> String {
        to.map { "\(which) overpass: \($0.satellite) over \($0.station), \($0.overpass.minuteLabel) UTC" } ?? "No \(which.lowercased()) overpass listed"
    }

    /// A round icon button of the bar, lit while `isOn`.
    private func button(_ label: String, symbol: String, isOn: Bool = false, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.footnote.weight(.semibold))
                .frame(width: 32, height: 32)
                .background(isOn ? Color.white.opacity(0.18) : .clear, in: .circle)
                .foregroundStyle(isOn ? Color.panelAccent : Color.panelInk)
                .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .help(help)
    }
}
