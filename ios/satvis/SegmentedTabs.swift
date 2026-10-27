import SwiftUI

/// Tabs with the web app's counts as badges, which the system's segmented control
/// cannot draw: it takes a segment's text alone. Drawn as that control is, on a
/// card's raised track, so that it matches the panels' other pickers.
struct SegmentedTabs<Value: Hashable>: View {
    @Binding var selection: Value
    /// Each tab, its name and its count; a count of 0 shows none.
    let tabs: [(value: Value, title: String, count: Int)]
    @Namespace private var thumb

    var body: some View {
        HStack(spacing: 0) {
            ForEach(tabs, id: \.value) { tab in
                self.tab(tab.value, tab.title, count: tab.count)
            }
        }
        .padding(2)
        .background(Color.panelRaised, in: .capsule)
        .accessibilityElement(children: .contain)
    }

    private func tab(_ value: Value, _ title: String, count: Int) -> some View {
        let isSelected = selection == value
        return Button {
            withAnimation(.snappy) { selection = value }
        } label: {
            HStack(spacing: 5) {
                Text(title)
                if count > 0 {
                    CountBadge(count: count)
                }
            }
            .font(.subheadline.weight(isSelected ? .semibold : .medium))
            .foregroundStyle(Color.panelInk)
            .lineLimit(1)
            .frame(maxWidth: .infinity, minHeight: 28)
            .background {
                if isSelected {
                    Capsule().fill(Color(uiColor: .systemGray2)).matchedGeometryEffect(id: "thumb", in: thumb)
                }
            }
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        // The picker's labels, which VoiceOver read and the UI tests find.
        .accessibilityLabel(count > 0 ? "\(title) (\(count))" : title)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// A count on a tab: the web app's `.countBadge` (src/css/main.css).
struct CountBadge: View {
    let count: Int

    var body: some View {
        Text("\(count)")
            .font(.caption2.weight(.semibold))
            .monospacedDigit()
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(Color.panelSelected, in: .capsule)
    }
}
