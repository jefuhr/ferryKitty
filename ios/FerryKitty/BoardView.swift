import SwiftUI
import FerryCore

/// Layout rules for the departure board, separate from the views so they can be unit tested.
enum BoardLayout {
    /// A second column once each can hold time, route, destination and status at about 300 points.
    static let twoColumnWidth: CGFloat = 600
    static let maxWidth: CGFloat = 1200

    static func columns(width: CGFloat, accessibilityText: Bool) -> Int {
        !accessibilityText && width >= twoColumnWidth ? 2 : 1
    }

    /// Row-major, so the next two sailings share the first row.
    static func rows<Item>(of items: [Item], columns: Int) -> [[Item]] {
        let size = max(1, columns)
        return stride(from: 0, to: items.count, by: size).map { Array(items[$0..<min($0 + size, items.count)]) }
    }

    /// The countdown in the time column's width. Minutes round up, as on the web board.
    static func countdown(seconds delta: Double, live: Bool, dueLabel: String) -> String {
        guard live else { return "" }
        if delta <= 90 { return dueLabel }
        if delta >= 86400 { return "Tomorrow" }
        let minutes = Int(ceil(delta / 60))
        if minutes < 60 { return "\(minutes) min" }
        return minutes % 60 == 0 ? "\(minutes / 60)h" : "\(minutes / 60)h \(minutes % 60)m"
    }

    static func spokenCountdown(seconds delta: Double, live: Bool, dueLabel: String) -> String? {
        guard live else { return nil }
        if delta <= 90 { return dueLabel }
        if delta >= 86400 { return "tomorrow" }
        let minutes = Int(ceil(delta / 60))
        let hours = minutes / 60, remainder = minutes % 60
        return "in " + [hours > 0 ? "\(hours) hour\(hours == 1 ? "" : "s")" : nil,
                        remainder > 0 ? "\(remainder) minute\(remainder == 1 ? "" : "s")" : nil].compactMap { $0 }.joined(separator: " ")
    }

    /// Drop-off and no-pickup outrank live timing, which outranks the scheduled clock.
    static func status(arrival: Bool, noPickup: Bool, hasLiveTiming: Bool, delay: Double) -> DepartureStatus {
        if arrival { return .dropOff }
        if noPickup { return .noPickup }
        if hasLiveTiming { return delay >= 60 ? .late(minutes: Int((delay / 60).rounded())) : .onTime }
        return .scheduled
    }

    /// A scheduled layover carries an inline clock; an estimated one says "est" instead.
    static func layover(minutes: Int, estimated: Bool) -> LayoverLabel {
        LayoverLabel(text: "Layover \(minutes)m" + (estimated ? " est" : ""), showsClock: !estimated,
                     spoken: "layover \(minutes) minutes \(estimated ? "estimated" : "scheduled")")
    }

    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "EEE MMM d"
        return formatter
    }()

    /// Browsed dates name their weekday: weekday and weekend timetables differ.
    static func dateLabel(_ key: String) -> String {
        ServiceClock.date(key).map(dateFormatter.string(from:)) ?? key
    }
}

enum DepartureStatus: Equatable {
    case dropOff, noPickup, onTime, late(minutes: Int), scheduled

    /// Nil for a scheduled departure, which shows a clock icon rather than text.
    var text: String? {
        switch self {
        case .dropOff: "DROP OFF ONLY"
        case .noPickup: "NO PICKUP"
        case .onTime: "ON TIME"
        case .late(let minutes): "+\(minutes)m"
        case .scheduled: nil
        }
    }
    var spoken: String { text?.lowercased() ?? "scheduled" }
    var color: Color {
        switch self {
        case .dropOff, .noPickup, .late: .orange
        case .onTime: .green
        case .scheduled: .secondary
        }
    }
}

struct LayoverLabel: Equatable {
    let text: String
    let showsClock: Bool
    let spoken: String
}

struct BoardView: View {
    @EnvironmentObject private var store: FerryStore
    @Environment(\.dynamicTypeSize) private var textSize
    private var favorites: [Landing] {
        (store.roster?.landings ?? []).filter { store.preferences.favorites.contains($0.id) }
            .sorted { $0.displayName.localizedStandardCompare($1.displayName) == .orderedAscending }
    }
    var body: some View {
        GeometryReader { proxy in
            let columns = BoardLayout.columns(width: proxy.size.width, accessibilityText: textSize.isAccessibilitySize)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                    if columns == 1 { quickActions }
                    Section {
                        notices
                        board(columns: columns)
                    } header: { controls(wide: columns > 1) }
                }.padding(.bottom, 8)
                    .frame(maxWidth: columns > 1 ? BoardLayout.maxWidth : 900)
                    .frame(maxWidth: .infinity, alignment: .top)
            }
        }
        .background(store.theme.background)
        .refreshable { await store.refreshAll() }
        .navigationTitle("Departures")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Choose landing", systemImage: "list.bullet") { store.sheet = .landings }.accessibilityIdentifier("chooseLanding")
            }
            ToolbarItem(placement: .principal) { title }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button("Filter operators and routes", systemImage: store.preferences.departureFilters.isActive ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle") { store.sheet = .operators }.accessibilityIdentifier("operatorFilter")
                Button("Settings", systemImage: "gearshape") { store.sheet = .settings }.accessibilityIdentifier("settings")
            }
        }
    }

    /// The landing, whether its times are live, and the clock, in the navigation bar's title.
    private var title: some View {
        Button { store.sheet = .landings } label: {
            VStack(spacing: 1) {
                HStack(spacing: 3) {
                    Text(store.landingTitle).font(.headline).lineLimit(1)
                    Image(systemName: "chevron.down").font(.caption2.bold()).foregroundStyle(.secondary)
                }
                HStack(spacing: 4) {
                    Circle().fill(store.realtime.stale || !store.isToday ? Color.secondary : Color.green).frame(width: 6, height: 6)
                    Text("\(store.time(store.now)) · \(freshness)").lineLimit(1)
                }.font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
            }.frame(minHeight: 44).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityIdentifier("landingTitle")
            .accessibilityLabel("\(store.landingTitle), \(freshness), \(store.time(store.now))")
            .accessibilityHint("Choose landing")
    }
    private var freshness: String {
        !store.isToday ? "Published schedule" : store.realtime.available == false ? "Scheduled · live unavailable" : store.realtime.stale ? "Scheduled · saved data" : "Live estimates"
    }

    private var quickActions: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 6) {
                Button {
                    if store.rideSession != nil { store.showingRide = true } else { store.sheet = .vessels(nil) }
                } label: { Label("Your boat", systemImage: "ferry") }
                    .accessibilityIdentifier("boardChooseBoat")
                NearestLandingButton()
                ForEach(favorites) { landing in
                    let button = Button { store.selectLanding(landing.id) } label: { Label(landing.displayName, systemImage: "star.fill") }
                        .font(.footnote.bold())
                        .accessibilityIdentifier("quickLanding-\(landing.id)")
                    if store.preferences.landingID == landing.id {
                        button.buttonStyle(.borderedProminent).accessibilityAddTraits(.isSelected)
                    } else { button }
                }
            }.buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.small)
                .font(.footnote.weight(.medium)).padding(.horizontal, 12).padding(.vertical, 6)
        }.scrollIndicators(.hidden)
            // Fades rather than clips, so a cut-off favorite reads as "scroll for more".
            .mask(LinearGradient(stops: [.init(color: .black, location: 0.9), .init(color: .clear, location: 1)], startPoint: .leading, endPoint: .trailing))
    }

    /// Pinned under the navigation bar. Wide boards keep the shortcuts here too, in one row.
    private func controls(wide: Bool) -> some View {
        HStack(spacing: 8) {
            if wide {
                quickActions.frame(maxWidth: .infinity)
                dateControls.fixedSize()
            } else {
                dateControls.frame(maxWidth: .infinity)
            }
            sortControl.frame(width: 128).padding(.trailing, 12)
        }.background(.regularMaterial)
    }
    private var sortControl: some View {
        Picker("Sort departures", selection: $store.preferences.sortByRoute) {
            Text("Time").tag(false); Text("Route").tag(true)
        }.pickerStyle(.segmented).accessibilityIdentifier("departureSort")
    }
    private var dateControls: some View {
        HStack(spacing: 0) {
            Button { store.stepDate(-1) } label: { Image(systemName: "chevron.left").frame(width: 40, height: 44) }
                .accessibilityLabel("Previous day").accessibilityIdentifier("previousDay").disabled(!canStep(-1))
            // A browsed date is amber so it cannot be mistaken for today's board.
            Button { store.viewDate = nil } label: {
                Text(store.isToday ? "Today" : BoardLayout.dateLabel(store.currentDate))
                    .font(.subheadline.weight(.semibold)).foregroundStyle(store.isToday ? store.theme.accent : .orange)
                    .fixedSize().frame(minWidth: 84, minHeight: 44)
            }.accessibilityLabel(store.isToday ? "Today" : "\(store.currentDate), return to today").accessibilityIdentifier("scheduleDate")
            Button { store.stepDate(1) } label: { Image(systemName: "chevron.right").frame(width: 40, height: 44) }
                .accessibilityLabel("Next day").accessibilityIdentifier("nextDay").disabled(!canStep(1))
        }
    }
    private func canStep(_ delta: Int) -> Bool {
        guard let data = store.schedule else { return false }
        return ScheduleEngine.range(data)?.contains(ServiceClock.addDays(store.currentDate, delta)) == true
    }

    @ViewBuilder private func board(columns: Int) -> some View {
        let rows = store.rows
        if store.schedule == nil {
            if store.loadingLanding { ProgressView("Loading schedule…").frame(maxWidth: .infinity).padding(32) }
            else {
                MessageCard(title: "Schedule unavailable", message: store.boardError ?? "Connect to load your first landing.")
                Button("Try again") { Task { await store.refreshAll() } }.buttonStyle(.borderedProminent).frame(maxWidth: .infinity)
            }
        } else if rows.isEmpty { emptyBoard }
        else if store.preferences.sortByRoute {
            ForEach(Array(BoardLayout.rows(of: store.groups, columns: columns).enumerated()), id: \.offset) { _, line in
                HStack(alignment: .top, spacing: 1) {
                    ForEach(line) { RouteGroupView(group: $0) }
                    ForEach(line.count..<columns, id: \.self) { _ in Color.clear.frame(maxWidth: .infinity) }
                }.fixedSize(horizontal: false, vertical: true)
            }
        } else {
            // Equal-height cells and one rule per row keep a two-column board reading left to right.
            ForEach(Array(BoardLayout.rows(of: rows, columns: columns).enumerated()), id: \.offset) { _, line in
                HStack(alignment: .top, spacing: 0) {
                    ForEach(line) { DepartureButton(row: $0) }
                    ForEach(line.count..<columns, id: \.self) { _ in Color.clear.frame(maxWidth: .infinity) }
                }.fixedSize(horizontal: false, vertical: true)
                Divider().padding(.horizontal, 12)
            }
        }
    }

    private var notices: some View {
        VStack(alignment: .leading, spacing: 0) {
            Group {
                if let note = store.boardNote { Text(note).foregroundStyle(.secondary) }
                if let error = store.boardError, store.schedule != nil { Label(error, systemImage: "wifi.slash").foregroundStyle(.secondary) }
                if let warning = store.offlineWarning, warning != store.boardError {
                    Label(warning, systemImage: "externaldrive.badge.exclamationmark").foregroundStyle(.secondary)
                }
            }.font(.caption).padding(.horizontal, 12).padding(.top, 6)
            alerts
        }
    }
    /// Only active alerts, or a failed alert feed, take a line on the board.
    @ViewBuilder private var alerts: some View {
        let count = store.alerts?.alerts.count ?? 0
        if count > 0 || store.alerts?.available == false {
            Button { store.sheet = .alerts } label: {
                HStack(spacing: 6) {
                    Image(systemName: count > 0 ? "exclamationmark.triangle.fill" : "exclamationmark.bubble")
                        .foregroundStyle(count > 0 ? Color.orange : .secondary)
                    Text(alertLabel).lineLimit(1)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.secondary)
                }.font(.footnote).padding(.horizontal, 12).frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
                    .background(count > 0 ? Color.orange.opacity(0.1) : .clear).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityIdentifier("serviceAlerts").padding(.top, 6)
        }
    }
    private var alertLabel: String {
        let count = store.alerts?.alerts.count ?? 0
        let prefix = store.alerts?.stale == true ? "Saved alerts" : "Alerts"
        if count > 0 { return "\(prefix) (\(count)) · \(store.alerts?.alerts.first?.header ?? "Service notices")" }
        return "Alerts unavailable"
    }
    @ViewBuilder private var emptyBoard: some View {
        if let schedule = store.schedule, ScheduleEngine.range(schedule)?.contains(store.currentDate) != true {
            MessageCard(title: "Schedule unavailable", message: "No saved schedule covers this date. Connect to refresh.", symbol: "calendar.badge.exclamationmark")
        } else if store.preferences.departureFilters.isActive {
            MessageCard(title: "No matching departures", message: "Try showing all departures or another date.", symbol: "line.3.horizontal.decrease.circle")
            Button("Show all departures") { store.preferences.resetDepartureFilters() }.padding(.horizontal, 12)
        } else {
            MessageCard(title: "No scheduled departures", message: store.isToday ? "No more departures are listed for today." : "No boats are scheduled for this date.", symbol: "ferry")
        }
    }
}

private struct RouteGroupView: View {
    @EnvironmentObject private var store: FerryStore
    let group: DepartureGroup
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                RouteBadge(routeID: group.routeId, variant: group.variant)
                Text(group.destination).font(.subheadline.weight(.semibold)).lineLimit(2)
                Spacer(minLength: 0)
            }.padding(.horizontal, 12).padding(.vertical, 5).background(store.theme.accent.opacity(0.1))
                .accessibilityElement(children: .combine).accessibilityAddTraits(.isHeader)
            ForEach(group.departures) { row in
                DepartureButton(row: row, showRoute: false)
                if row.id != group.departures.last?.id { Divider().padding(.leading, 12) }
            }
        }
        // Rows keep their own height; a shorter group beside a longer one ends early.
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

struct RouteBadge: View {
    @EnvironmentObject private var store: FerryStore
    let routeID: String
    var variant: String?
    /// Partner operators are shown by their own marks.
    static func partnerMark(_ routeID: String) -> String? {
        let partners = [("wtr:", "Waterway"), ("wbf:", "Waterway"), ("sea:", "Seastreak"), ("nyu:", "NYU"), ("lib:", "CityFerry"), ("gi:", "GovernorsIsland")]
        return partners.first { routeID.hasPrefix($0.0) }?.1
    }
    var body: some View {
        let route = store.schedule?.routes[routeID]
        let short = route?.shortName ?? routeID
        Group {
            if let asset = Self.partnerMark(routeID) {
                Image(asset).resizable().scaledToFit().padding(2).frame(width: 44, height: 22)
                    .background(.white, in: RoundedRectangle(cornerRadius: 4)).accessibilityLabel(store.operatorName(routeID))
                    // Sit on the text baseline like a letter badge rather than above it.
                    .alignmentGuide(.firstTextBaseline) { $0.height * 0.75 }
            } else {
                Text(short + (variant.map { " \($0)" } ?? "")).font(.caption.weight(.heavy))
                    .padding(.horizontal, 5).padding(.vertical, 3).frame(minWidth: 30, minHeight: 22)
                    .foregroundStyle(Color(hex: route?.textColor ?? "FFFFFF"))
                    .background(Color(hex: route?.color), in: RoundedRectangle(cornerRadius: 4))
            }
        }.fixedSize(horizontal: true, vertical: false)
    }
}

/// One sailing in two lines. By time: when, route and destination, status; then the countdown and
/// who is working it. By route the group already names the destination, so the first line names the boat.
struct DepartureButton: View {
    @EnvironmentObject private var store: FerryStore
    @Environment(\.dynamicTypeSize) private var textSize
    let row: ScheduledDeparture
    var showRoute = true
    private var departure: Departure { row.departure }
    private var canOpen: Bool {
        guard let schedules = store.schedule?.tripSchedules,
              let trip = schedules[departure.tripId] ?? schedules[departure.liveTripId ?? departure.tripId] else { return false }
        return trip.stops.count >= 2 || trip.timetableOnly == true
    }
    private var noPickup: Bool { departure.arrival == true || departure.outOfService == true || departure.crewShuttle == true }
    private static let clockFont = Font.body.weight(.semibold).monospacedDigit()

    var body: some View {
        let pauses = store.displaySchedule.map { ScheduleEngine.departurePauses(data: $0, row: row, realtime: store.realtime) }
        let details = details(pauses)
        Button { if canOpen { store.sheet = .trip(row) } } label: {
            Group {
                if textSize.isAccessibilitySize { stacked(details) } else { compact(details) }
            }.padding(.horizontal, 12).padding(.vertical, 6)
                // One-line rows center in the touch target; a row beside a taller one keeps to the top.
                .frame(minHeight: 44, alignment: .leading)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityIdentifier("departure-\(departure.tripId)")
            .accessibilityLabel(spoken(pauses))
            .accessibilityHint(canOpen ? "Show trip details" : "Published movement; no trip detail available")
    }

    private func compact(_ details: Text?) -> some View {
        Grid(alignment: .leading, horizontalSpacing: 8, verticalSpacing: 2) {
            GridRow(alignment: .firstTextBaseline) {
                // Sized by a template so times and countdowns line up down the board.
                ZStack(alignment: .leading) {
                    Text(store.preferences.twelveHour ? "00:00 PM*" : "00:00*").hidden()
                    Text(timeLabel)
                }.font(Self.clockFont)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if showRoute {
                        RouteBadge(routeID: departure.routeId, variant: departure.variant)
                        Text(departure.destination).font(.subheadline.weight(.semibold)).lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        ZStack(alignment: .leading) { Text("00h 00m").font(.caption.weight(.semibold)).hidden(); countdown }
                        vessel.map { $0.font(.subheadline) }.lineLimit(1)
                    }
                    Spacer(minLength: 4)
                    VStack(alignment: .trailing, spacing: 1) { status; slipText }
                }
            }
            if (showRoute && !countdownLabel.isEmpty) || hasFlags || details != nil {
                GridRow(alignment: .firstTextBaseline) {
                    if showRoute { countdown } else { Color.clear.frame(width: 0, height: 0) }
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        flags
                        // Height follows the lines the text needs at the column's final width, never its one-line ideal.
                        details.map { $0.font(.caption).foregroundStyle(.secondary).lineLimit(3).fixedSize(horizontal: false, vertical: true) }
                    }
                }
            }
        }
    }
    private func stacked(_ details: Text?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) { Text(timeLabel).font(Self.clockFont); Spacer(minLength: 4); countdown }
            if showRoute {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    RouteBadge(routeID: departure.routeId, variant: departure.variant)
                    Text(departure.destination).font(.subheadline.weight(.semibold))
                }
            } else if let vessel { vessel.font(.subheadline) }
            HStack(spacing: 4) { status; flags }
            slipText.frame(maxWidth: .infinity, alignment: .trailing)
            details.map { $0.font(.caption).foregroundStyle(.secondary) }
        }
    }

    private var countdownLabel: String {
        BoardLayout.countdown(seconds: row.delta, live: row.live, dueLabel: noPickup ? "Due" : "Boarding")
    }
    private var countdown: some View {
        Text(countdownLabel).font(.caption.weight(.semibold)).foregroundStyle(store.theme.accent).lineLimit(1)
    }
    private var timeLabel: String {
        store.time(departure.seconds + row.delay) + (departure.approximate == true ? "*" : "")
    }
    private var working: String? {
        departure.boatAssignment.map { "\(store.schedule?.routes[departure.routeId]?.shortName ?? departure.routeId)\($0)" }
    }
    /// Working number and vessel: confirmed, predicted with a question mark, or the crew boats.
    private var vessel: Text? {
        var parts: [Text] = []
        if let working { parts.append(Text(working).bold()) }
        if let boat = row.boatName { parts.append(Text(boat)) }
        else if let prediction = row.predictedBoatName { parts.append(Text(prediction + "?").italic()) }
        else if let crew = departure.crewBoats, !crew.isEmpty { parts.append(Text(crew.joined(separator: " "))) }
        return join(parts, " ")
    }
    private var until: String? { departure.secondsEnd.map { "until " + store.time($0) } }
    private func details(_ pauses: DeparturePauses?) -> Text? {
        var parts: [Text] = []
        if showRoute, let vessel { parts.append(vessel.foregroundStyle(.primary)) }
        if departure.crewShuttle == true { parts.append(Text(["Crew shuttle", until].compactMap { $0 }.joined(separator: " "))) }
        else if departure.outOfService == true { parts.append(Text(["Out of service", until].compactMap { $0 }.joined(separator: " "))) }
        else {
            if let until { parts.append(Text(until)) }
            if showRoute, let name = otherOperator { parts.append(Text(name)) }
        }
        if let via = departure.viaTerminals, !via.isEmpty {
            parts.append(Text(via.map { "VIA " + $0.code }.joined(separator: " · ")).fontWeight(.semibold))
        } else if let via = departure.via, !via.isEmpty {
            parts.append(Text("via " + via.joined(separator: ", ")))
        }
        // Most feeds repeat the arrival time as the departure time; a zero dwell says nothing.
        if let minutes = pauses?.dwellMinutes, minutes > 0 { parts.append(Text("Dwell \(minutes)m").monospacedDigit()) }
        if let layover = pauses?.layover {
            let label = BoardLayout.layover(minutes: layover.minutes, estimated: layover.hasLiveTiming)
            // The clock follows the text inline. A no-break space glues it to the minutes, so it never wraps alone.
            parts.append((label.showsClock ? Text(label.text + "\u{00A0}") + Text(Image(systemName: "clock")) : Text(label.text)).monospacedDigit())
        }
        if departure.approximate == true && departure.fromHomePort == true { parts.append(Text("Approx. · first pickup at destination")) }
        return join(parts, " · ")
    }
    /// Named only for operators without a partner mark in the route badge.
    private var otherOperator: String? {
        let name = store.operatorName(departure.routeId)
        return RouteBadge.partnerMark(departure.routeId) == nil && !departure.routeId.hasPrefix("nyc:") && name != "NYC Ferry" ? name : nil
    }
    private func join(_ parts: [Text], _ separator: String) -> Text? {
        guard let first = parts.first else { return nil }
        return parts.dropFirst().reduce(first) { $0 + Text(separator) + $1 }
    }

    private var statusKind: DepartureStatus {
        BoardLayout.status(arrival: departure.arrival == true, noPickup: departure.crewShuttle == true || departure.outOfService == true,
                           hasLiveTiming: row.hasLiveTiming, delay: row.delay)
    }
    /// Unconfirmed times show a small clock; every other state keeps its own pill.
    @ViewBuilder private var status: some View {
        if let text = statusKind.text { StatusPill(text: text, color: statusKind.color) } else { ScheduledBadge() }
    }
    private var final: String? {
        guard let end = departure.endsShift, departure.outOfService != true, departure.crewShuttle != true else { return nil }
        return end == "unsure" ? "FINAL?" : "FINAL"
    }
    /// "Slip 2" stays as is; a side such as "North" reads as "North slip".
    private var slip: String? {
        guard let name = row.slipName, !name.isEmpty else { return nil }
        return name.localizedCaseInsensitiveContains("slip") ? name : name + " slip"
    }
    /// Sits under the ON TIME / late status, right-aligned.
    @ViewBuilder private var slipText: some View {
        if let slip {
            Text(slip).font(.caption2.weight(.semibold)).foregroundStyle(store.theme.accent).lineLimit(1).fixedSize()
                .accessibilityIdentifier("departureSlip")
        }
    }
    private var hasFlags: Bool { row.isLastOfDay || row.isLastGovernorsIsland || final != nil }
    @ViewBuilder private var flags: some View {
        if row.isLastOfDay || row.isLastGovernorsIsland { StatusPill(text: "LAST", color: .red) }
        if let final { StatusPill(text: final, color: .orange) }
    }

    /// VoiceOver reads the row as one sentence rather than its abbreviations.
    private func spoken(_ pauses: DeparturePauses?) -> String {
        var parts = [store.time(departure.seconds + row.delay) + (departure.approximate == true ? ", approximate" : "")]
        if let countdown = BoardLayout.spokenCountdown(seconds: row.delta, live: row.live, dueLabel: noPickup ? "Due" : "Boarding") {
            parts.append(countdown)
        }
        if showRoute {
            parts.append("\(store.schedule?.routes[departure.routeId]?.shortName ?? departure.routeId) to \(departure.destination)")
            if let name = otherOperator ?? RouteBadge.partnerMark(departure.routeId).map({ _ in store.operatorName(departure.routeId) }) { parts.append(name) }
        }
        parts.append(statusKind.spoken)
        if let slip { parts.append("boards at \(slip)") }
        if row.isLastOfDay { parts.append("last departure") } else if row.isLastGovernorsIsland { parts.append("last to Governors Island") }
        if let final { parts.append(final == "FINAL" ? "final, no return trip" : "final, return trip unconfirmed") }
        if let working { parts.append("working \(working)") }
        if let boat = row.boatName { parts.append("vessel \(boat)") }
        else if let prediction = row.predictedBoatName { parts.append("predicted vessel \(prediction), unconfirmed") }
        else if let crew = departure.crewBoats, !crew.isEmpty { parts.append(crew.joined(separator: ", ")) }
        if departure.crewShuttle == true { parts.append("crew shuttle") } else if departure.outOfService == true { parts.append("out of service") }
        if let until { parts.append(until) }
        if let via = departure.viaTerminals, !via.isEmpty { parts.append("via " + via.map { $0.name ?? $0.code }.joined(separator: ", ")) }
        else if let via = departure.via, !via.isEmpty { parts.append("via " + via.joined(separator: ", ")) }
        if let minutes = pauses?.dwellMinutes, minutes > 0 { parts.append("dwell \(minutes) minutes") }
        if let layover = pauses?.layover { parts.append(BoardLayout.layover(minutes: layover.minutes, estimated: layover.hasLiveTiming).spoken) }
        if departure.approximate == true && departure.fromHomePort == true { parts.append("first pickup time at destination") }
        return parts.joined(separator: ", ")
    }
}
