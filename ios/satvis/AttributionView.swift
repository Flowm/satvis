import SatvisRender
import SwiftUI

/// What the web app's credit display lists: the sources of the map as drawn now,
/// of the satellites, and the privacy policy.
struct AttributionView: View {
    let map: [Credit]
    let privacyPolicy: URL
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
