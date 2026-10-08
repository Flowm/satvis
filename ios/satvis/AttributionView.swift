import SatvisRender
import SwiftUI

/// What the web app's credit display lists: the sources of the map as drawn now,
/// of the satellites, and the privacy policy, with the switch for what it covers.
struct AttributionView: View {
    let map: [Credit]
    let privacyPolicy: URL
    let analytics: Analytics
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("Map") {
                    ForEach(map, id: \.self, content: CreditRow.init)
                }
                Section("Satellites") {
                    CreditRow(credit: .elementSets)
                }
                Section {
                    Link("Privacy", destination: privacyPolicy)
                    // Where the policy it answers to is; the web app has no switch,
                    // its menu none to keep it in.
                    Toggle(
                        "Share usage data",
                        isOn: Binding {
                            analytics.isSharing
                        } set: {
                            analytics.setSharing($0)
                        }
                    )
                    // Nothing is counted where usage may not be at all: not a
                    // debug build, and not another site than satvis.space.
                    .disabled(!Analytics.isAvailable)
                    NavigationLink("Acknowledgements") { AcknowledgementsView() }
                }
            }
            .navigationTitle("Attribution")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

private struct CreditRow: View {
    let credit: Credit

    var body: some View {
        if let link = credit.link {
            Link(credit.text, destination: link)
        } else {
            Text(credit.text)
        }
    }
}
