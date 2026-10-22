import SwiftUI
import UIKit
import FerryCore

@main
struct FerryKittyApp: App {
    @StateObject private var store: FerryStore
    init() {
        let settings = AppConfiguration.makeStore()
        _store = StateObject(wrappedValue: settings)
    }
    var body: some Scene {
        WindowGroup { FerryRootView().environmentObject(store) }
    }
}

@MainActor
enum AppConfiguration {
    static func makeStore() -> FerryStore {
        let baseURL = URL(string: Bundle.main.object(forInfoDictionaryKey: "FerryAPIBaseURL") as? String ?? "https://juliet.nyc")!
        // Keep the existing cache directory when upgrading from Ferry Board.
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("FerryBoard", isDirectory: true)
        #if DEBUG
        if ProcessInfo.processInfo.environment["FERRY_UI_TESTS"] == "1" {
            let defaults = UserDefaults(suiteName: "nyc.juliet.ferryboard.ui-tests")!
            let testRoot = root.appendingPathComponent("UI-Tests", isDirectory: true)
            if ProcessInfo.processInfo.environment["FERRY_RESET"] == "1" {
                defaults.removePersistentDomain(forName: "nyc.juliet.ferryboard.ui-tests")
                try? FileManager.default.removeItem(at: testRoot)
            }
            let transport = PreviewTransport(offline: ProcessInfo.processInfo.environment["FERRY_OFFLINE"] == "1")
            let repository = FerryRepository(transport: transport, cache: SnapshotCache(directory: testRoot), namespace: "fixtures")
            return FerryStore(repository: repository, defaults: defaults, fixedNow: ServiceClock.instant("2026-09-04T12:50:00Z"))
        }
        #endif
        let makeRepository = { (url: URL) in
            FerryRepository(transport: HTTPTransport(baseURL: url), cache: SnapshotCache(directory: root), namespace: url.absoluteString)
        }
        return FerryStore(repository: makeRepository(baseURL), productionURL: baseURL, makeRepository: makeRepository, ferryRT: .live)
    }
}

struct FerryRootView: View {
    @EnvironmentObject private var store: FerryStore
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var systemTextSize
    @State private var sidebar: NavigationSplitViewVisibility = .automatic
    @State private var widgetLandingID: Int?
    var body: some View {
        GeometryReader { window in
            if UIDevice.current.userInterfaceIdiom == .pad && window.size.width >= 760 {
                // The landing list sits beside the board only when the board keeps two columns.
                // Narrower windows show it over the board and close it after a choice.
                let docked = window.size.width - 280 >= BoardLayout.twoColumnWidth
                NavigationSplitView(columnVisibility: $sidebar) {
                    LandingPicker(dismissOnSelection: false) { if !docked { sidebar = .detailOnly } }
                        .navigationTitle("Landings")
                        .navigationSplitViewColumnWidth(min: 250, ideal: 280, max: 340)
                } detail: {
                    NavigationStack {
                        Group {
                            if store.tab == .map { HarborMapView() }
                            else { BoardView() }
                        }.safeAreaInset(edge: .bottom, spacing: 0) { rideBar }
                    }
                }
                .navigationSplitViewStyle(.automatic)
                .onAppear { sidebar = docked ? .all : .detailOnly }
                .onChange(of: docked) { _, value in sidebar = value ? .all : .detailOnly }
                .accessibilityIdentifier("tabletWorkspace")
            } else {
                mainTabs
            }
        }
        .tint(store.theme.accent).preferredColorScheme(store.theme.scheme)
        .sheet(item: $store.sheet, onDismiss: store.sheetDismissed) { sheet in FerrySheetView(sheet: sheet) }
        .fullScreenCover(isPresented: $store.showingRide) { RideView().tint(store.theme.accent).preferredColorScheme(store.theme.scheme) }
        .dynamicTypeSize(store.preferences.textSize.resolved(systemTextSize))
        .task { store.setActive(scenePhase == .active); updateScreenAwake() }
        .onChange(of: scenePhase) { _, phase in
            store.setActive(phase == .active)
            updateScreenAwake()
        }
        .onChange(of: store.preferences.keepScreenAwake) { _, _ in updateScreenAwake() }
        .onChange(of: store.tab) { _, _ in store.viewChanged() }
        .onChange(of: store.showingRide) { _, _ in store.viewChanged() }
        .onOpenURL { url in
            guard let link = FerryWidgetLink(url) else { return }
            store.showingRide = false
            store.tab = .departures
            store.viewDate = nil
            switch link {
            case .nearby:
                widgetLandingID = nil
                store.sheet = .widgetSetup
            case .landing(let id):
                store.sheet = nil
                widgetLandingID = id
                openWidgetLanding()
            }
        }
        .onChange(of: store.roster?.landings.map(\.id)) { _, _ in openWidgetLanding() }
    }
    private func openWidgetLanding() {
        guard let id = widgetLandingID, let roster = store.roster else { return }
        widgetLandingID = nil
        if roster.landings.contains(where: { $0.id == id }) { store.selectLanding(id) }
        else { store.sheet = .landings }
    }
    private var mainTabs: some View {
        TabView(selection: $store.tab) {
            NavigationStack { BoardView().safeAreaInset(edge: .bottom, spacing: 0) { rideBar } }
                .tabItem { Label("Departures", systemImage: "ferry") }.tag(FerryTab.departures)
            NavigationStack { HarborMapView().safeAreaInset(edge: .bottom, spacing: 0) { rideBar } }
                .tabItem { Label("Map", systemImage: "map") }.tag(FerryTab.map)
        }
    }
    private func updateScreenAwake() {
        UIApplication.shared.isIdleTimerDisabled = scenePhase == .active && store.preferences.keepScreenAwake
    }
    @ViewBuilder private var rideBar: some View {
        if let session = store.rideSession, !store.showingRide {
            Button { store.showingRide = true } label: {
                HStack(spacing: 8) {
                    Image(systemName: "ferry.fill").font(.subheadline)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(session.vessel.name).font(.subheadline.weight(.semibold))
                        if let ride = store.ride, let stop = ride.nextStop {
                            Text("\(stop.name) · ARR \(store.time(stop.instant(arrival: true, stale: ride.stale), timezone: ride.timezone))")
                                .font(.caption).foregroundStyle(.secondary)
                        } else {
                            Text("Your boat · tap to return").font(.caption).foregroundStyle(.secondary)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    if store.ride == nil {
                        Text("Loading").font(.caption2)
                    } else if store.ride?.stale != false || store.ride?.positionStale != false {
                        Text("SAVED").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    }
                    Image(systemName: "chevron.up").font(.caption).accessibilityHidden(true)
                }.padding(.horizontal, 12).padding(.vertical, 5)
                    .frame(maxWidth: .infinity, minHeight: 48).background(.regularMaterial)
            }.buttonStyle(.plain).accessibilityIdentifier("rideBar")
                .accessibilityHint("Return to your boat's confirmed trips")
        }
    }
}

#if DEBUG
struct PreviewTransport: FerryTransport {
    let offline: Bool
    func data(for endpoint: FerryEndpoint) async throws -> Data {
        if offline { throw URLError(.notConnectedToInternet) }
        let name: String
        switch endpoint.path {
        case "api/display-data": name = "schedule-" + (endpoint.parameters["landingId"] ?? "16")
        case "api/ride": name = "ride-" + (endpoint.parameters["vesselId"] ?? "opportunity")
        default: name = endpoint.path.replacingOccurrences(of: "api/", with: "")
        }
        guard let url = Bundle.main.url(forResource: name, withExtension: "json") else { throw FerryError.http(404) }
        return try Data(contentsOf: url)
    }
}
#endif
