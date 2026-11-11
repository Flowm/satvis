import SatvisCore
import SwiftUI

/// The web app's Bookmarks panel (BookmarkPanel.vue): the featured and saved
/// bookmarks and the opened links as cards, the way back to the default view, and
/// saving the scene. A sheet, as the other long lists are; on a Mac a popover from
/// its entry in the menu column, which leaves the globe in sight.
struct BookmarksView: View {
    let session: Session
    /// A bookmark or the default view was opened, and the sheet closes on it.
    let onOpen: () -> Void
    /// Opens on `openingTab`.
    @State private var tab: Bookmark.Kind
    /// Whether the user has moved off the opening tab, which the arriving group
    /// index then leaves alone.
    @State private var moved = false
    /// The bookmark whose name is being edited, and the name as typed so far.
    @State private var renaming: Bookmark?
    @State private var draft = ""
    /// A picture is being taken, which a second tap must not repeat.
    @State private var saving = false
    /// The bookmarks deleted in the last five seconds, newest last, each with its
    /// own undo.
    @State private var deleted: [Bookmark] = []
    /// Where the share button and each card are in the window, for a share sheet's
    /// popover to point at on iPad.
    @State private var frames: [String: CGRect] = [:]
    /// The share button's key among `frames`, beside the cards' ids.
    private static let shareButton = "share"
    @Environment(\.dismiss) private var dismiss

    init(session: Session, onOpen: @escaping () -> Void = {}) {
        self.session = session
        self.onOpen = onOpen
        _tab = State(initialValue: Self.openingTab(session))
    }

    /// Saved for a user who has saved something, else Featured where the preset has any.
    private static func openingTab(_ session: Session) -> Bookmark.Kind {
        !session.bookmarks.saved.isEmpty ? .saved : session.featured.isEmpty ? .opened : .featured
    }

    /// Shows the `kind` tab, for good: the arriving group index no longer changes it.
    private func show(_ kind: Bookmark.Kind) {
        moved = true
        tab = kind
    }

    private var bookmarks: BookmarkModel { session.bookmarks }

    private var shown: [Bookmark] {
        switch tab {
        case .featured: session.featured
        case .saved: bookmarks.saved
        case .opened: bookmarks.opened
        }
    }

    /// A preset that features nothing has no Featured tab.
    private var tabs: [(value: Bookmark.Kind, title: String, count: Int)] {
        (session.featured.isEmpty ? [] : [(.featured, "Featured", 0)])
            + [(.saved, "Saved", bookmarks.saved.count), (.opened, "Recent", bookmarks.opened.count)]
    }

    var body: some View {
        let here = session.here
        // Save opens this rather than saving the scene twice.
        let savedHere = bookmarks.saved.first { $0.scene == here }
        NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    SegmentedTabs(selection: Binding(get: { tab }, set: show), tabs: tabs)
                    // Top-aligned: a wrapped name centred its neighbours in their row.
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 12, alignment: .top)], spacing: 12) {
                        ForEach(shown) { bookmark in
                            card(bookmark, isCurrent: bookmark.scene == here)
                        }
                    }
                    if shown.isEmpty {
                        Text(tab == .saved ? "Save this view to come back to it." : "Links you open show up here.")
                            .foregroundStyle(.secondary)
                            .padding(.top, 24)
                    }
                }
                .padding()
            }
            // The preset's featured bookmarks arrive with the group index, which can be
            // after the sheet opened.
            .onChange(of: session.featured.isEmpty) {
                if !moved {
                    tab = Self.openingTab(session)
                }
            }
            .navigationTitle("Bookmarks")
            .toolbarTitleDisplayMode(.inline)
            .panelSheet()
            #if os(iOS)
                // A popover on a Mac has no toolbar, and closes by a click outside it.
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        shareButton
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
            #endif
            // Under the cards with their names, as the web app's footer: the bottom
            // bar's glass shows icons alone.
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 8) {
                    ForEach(deleted) { bookmark in
                        undo(bookmark)
                    }
                    HStack {
                        Button("Default view", systemImage: "arrow.counterclockwise") {
                            session.openDefaultView()
                            onOpen()
                            dismiss()
                        }
                        .disabled(here.query.isEmpty)
                        #if os(macOS)
                            shareButton
                        #endif
                        Spacer()
                        // Filled, as the web app's: the sheet's main action.
                        Group {
                            if let savedHere {
                                Button("Saved", systemImage: "bookmark.fill") {
                                    show(.saved)
                                    startRename(savedHere)
                                }
                            } else {
                                Button("Save this view", systemImage: "bookmark") {
                                    Task {
                                        saving = true
                                        defer { saving = false }
                                        let bookmark = await session.saveHere()
                                        show(.saved)
                                        startRename(bookmark)
                                    }
                                }
                                .disabled(here.query.isEmpty || saving)
                            }
                        }
                        .buttonStyle(PanelButtonStyle(emphasis: .filled))
                    }
                    .buttonStyle(PanelButtonStyle())
                }
                .padding(.horizontal)
                .padding(.bottom, 8)
                .animation(.snappy, value: deleted)
            }
            .alert(
                "Name",
                isPresented: Binding {
                    renaming != nil
                } set: {
                    if !$0 { renaming = nil }
                }
            ) {
                TextField("Name", text: $draft)
                Button("Save") {
                    if let renaming {
                        bookmarks.rename(renaming.id, to: draft)
                    }
                }
                Button("Cancel", role: .cancel) {}
            }
        }
        // Closed, the sheet's undos go with it.
        .onDisappear {
            for bookmark in deleted {
                bookmarks.release(bookmark.id)
            }
        }
    }

    /// The view on screen, where the corner's Share button was; made when tapped,
    /// so that a clock off the present gives its minute then.
    private var shareButton: some View {
        Button("Share this view", systemImage: "square.and.arrow.up") {
            ShareSheet.present(session.link(sharing: true).url(site: session.site), from: frames[Self.shareButton] ?? .zero)
        }
        .reportsFrame { frames[Self.shareButton] = $0 }
    }

    private func card(_ bookmark: Bookmark, isCurrent: Bool) -> some View {
        let summary = session.summary(bookmark.scene)
        return Button {
            session.open(bookmark)
            onOpen()
            dismiss()
        } label: {
            BookmarkCard(bookmark: bookmark, summary: summary, picture: picture(bookmark), isCurrent: isCurrent)
        }
        .buttonStyle(.plain)
        .reportsFrame { frames[bookmark.id] = $0 }
        // The name first: read in order, the card starts with its picture's time.
        .accessibilityLabel([bookmark.name, summary.what, summary.where, summary.time ?? "Live"].joined(separator: ", "))
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
        .contextMenu { actions(bookmark) }
        // The long press's actions in sight.
        .overlay(alignment: .topTrailing) {
            Menu {
                actions(bookmark)
            } label: {
                Image(systemName: "ellipsis")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(.white)
                    .frame(width: 28, height: 28)
                    .background(.black.opacity(0.73), in: .circle)
                    .padding(4)
                    .contentShape(.rect)
            }
            .accessibilityLabel("Actions for \(bookmark.name)")
        }
    }

    @ViewBuilder private func actions(_ bookmark: Bookmark) -> some View {
        // Its own link, as it opens: live unless it was saved with a time.
        Button("Share", systemImage: "square.and.arrow.up") {
            ShareSheet.present(bookmark.scene.link().url(site: session.site), from: frames[bookmark.id] ?? .zero)
        }
        switch bookmark.kind {
        case .saved:
            Button("Rename", systemImage: "pencil") { startRename(bookmark) }
            Button("Delete", systemImage: "trash", role: .destructive) { delete(bookmark) }
        case .opened:
            Button("Save", systemImage: "bookmark") {
                if let kept = bookmarks.keep(bookmark.id, name: bookmark.name) {
                    show(.saved)
                    startRename(kept)
                }
            }
            Button("Forget", systemImage: "xmark") { bookmarks.forget(bookmark.id) }
        case .featured:
            EmptyView()
        }
    }

    /// A featured bookmark's picture is the site's, kept once fetched; the others' are the device's.
    private func picture(_ bookmark: Bookmark) -> Image? {
        let data = bookmark.kind == .featured ? bookmark.thumbnail.flatMap { session.featuredPictures[$0] } : bookmarks.pictures[bookmark.id]
        return data.flatMap(Image.init(encoded:))
    }

    private func startRename(_ bookmark: Bookmark) {
        draft = bookmark.name
        renaming = bookmark
    }

    private func undo(_ bookmark: Bookmark) -> some View {
        HStack {
            Text("Deleted “\(bookmark.name)”")
                .lineLimit(1)
            Spacer()
            Button("Undo") {
                bookmarks.restore(bookmark)
                deleted.removeAll { $0.id == bookmark.id }
            }
            .fontWeight(.semibold)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .panel()
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    /// Can be undone for five seconds.
    private func delete(_ bookmark: Bookmark) {
        bookmarks.remove(bookmark.id)
        deleted.append(bookmark)
        Task {
            try? await Task.sleep(for: .seconds(5))
            if deleted.contains(where: { $0.id == bookmark.id }) {
                deleted.removeAll { $0.id == bookmark.id }
                bookmarks.release(bookmark.id)
            }
        }
    }
}

/// One bookmark (BookmarkCard.vue): its picture with the time on it, its name, its
/// satellites and where the camera is; outlined while it is the scene on screen.
struct BookmarkCard: View {
    let bookmark: Bookmark
    let summary: BookmarkSummary
    let picture: Image?
    let isCurrent: Bool

    private static let live = Color(red: 0x8F / 255, green: 0xE3 / 255, blue: 0x9B / 255)

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Color.black
                .aspectRatio(16 / 10, contentMode: .fit)
                .overlay { image }
                .clipped()
                .overlay(alignment: .bottomLeading) {
                    badge(summary.time ?? "● Live", color: summary.time == nil ? Self.live : .white)
                }
                .overlay(alignment: .topLeading) {
                    if bookmark.kind == .opened {
                        TimelineView(.periodic(from: .now, by: 60)) { context in
                            badge(Bookmarks.timeAgo(bookmark.at, now: context.date.timeIntervalSince1970 * 1000), color: .white)
                        }
                    }
                }
            Text(bookmark.name)
                .font(.subheadline.weight(.semibold))
                .lineLimit(2)
                .padding(.horizontal, 8)
            BookmarkFacts(summary: summary)
                .font(.caption)
                .padding(.horizontal, 8)
        }
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.panelRaised, in: .rect(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8).strokeBorder(Color.panelAccent, lineWidth: isCurrent ? 2 : 0)
        }
        .contentShape(.rect(cornerRadius: 8))
    }

    @ViewBuilder private var image: some View {
        if let picture {
            picture.resizable().scaledToFill()
        } else {
            Image(systemName: "photo").foregroundStyle(.tertiary)
        }
    }

    private func badge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(.black.opacity(0.73), in: .rect(cornerRadius: 6))
            .padding(5)
    }
}

/// A bookmark's satellites and where its camera is, each a line beside its icon,
/// on its card and in About's carousel.
struct BookmarkFacts: View {
    let summary: BookmarkSummary
    /// The icons' side, with the text.
    @ScaledMetric(relativeTo: .caption) private var iconSide = 12.0

    var body: some View {
        Group {
            Label {
                Text(summary.what)
            } icon: {
                Image(.lucideOrbit).resizable().frame(width: iconSide, height: iconSide)
            }
            Label {
                Text(summary.where)
            } icon: {
                Image(whereIcon).resizable().frame(width: iconSide, height: iconSide)
            }
        }
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }

    /// The icon of the Sky, Globe or tracking camera.
    private var whereIcon: ImageResource {
        summary.where.hasPrefix("Sky") ? .lucideTelescope : summary.where.hasPrefix("Following") ? .lucideCrosshair : .lucideGlobe
    }
}

/// The system's share sheet with the link itself, not an item provider's promise of
/// it, over the Bookmarks sheet; on iPad a popover pointing at `rect`, in the
/// sheet's coordinates: SwiftUI's global space inside a sheet starts at the
/// sheet's corner, not the window's, where the popover pointed at first.
private enum ShareSheet {
    #if os(macOS)
        /// The share menu under `rect`, in the window clicked in: the Bookmarks
        /// popover's, which need not be the key window.
        static func present(_ url: URL, from rect: CGRect) {
            guard let view = (NSApplication.shared.currentEvent?.window ?? NSApplication.shared.keyWindow)?.contentView else {
                return
            }
            let target = view.isFlipped ? rect : CGRect(x: rect.minX, y: view.bounds.height - rect.maxY, width: rect.width, height: rect.height)
            NSSharingServicePicker(items: [url]).show(relativeTo: target, of: view, preferredEdge: .minY)
        }
    #else
        /// Over whatever is presented, the Bookmarks sheet itself.
        static func present(_ url: URL, from rect: CGRect) {
            let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
            guard var top = scene?.keyWindow?.rootViewController else {
                return
            }
            while let presented = top.presentedViewController, !presented.isBeingDismissed {
                top = presented
            }
            let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            if let popover = sheet.popoverPresentationController {
                popover.sourceView = top.view
                popover.sourceRect = rect
            }
            top.present(sheet, animated: true)
        }
    #endif
}
