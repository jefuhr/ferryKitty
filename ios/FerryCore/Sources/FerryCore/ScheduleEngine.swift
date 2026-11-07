import Foundation

public enum ServiceClock {
    public static func calendar(_ timezone: String = "America/New_York") -> Calendar {
        var value = Calendar(identifier: .gregorian)
        value.timeZone = TimeZone(identifier: timezone) ?? TimeZone(secondsFromGMT: 0)!
        value.locale = Locale(identifier: "en_US_POSIX")
        return value
    }

    public static func parts(_ date: Date, timezone: String = "America/New_York") -> (dateKey: String, seconds: Double) {
        let p = calendar(timezone).dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        return (String(format: "%04d-%02d-%02d", p.year!, p.month!, p.day!),
                Double(p.hour! * 3600 + p.minute! * 60 + p.second!))
    }

    public static func date(_ key: String, timezone: String = "UTC") -> Date? {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar(timezone).date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
    }

    public static func addDays(_ key: String, _ days: Int) -> String {
        guard let date = date(key), let next = calendar("UTC").date(byAdding: .day, value: days, to: date) else { return key }
        return parts(next, timezone: "UTC").dateKey
    }

    public static func instant(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let value = formatter.date(from: text) { return value }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: text)
    }

    public static func time(seconds: Double, twelveHour: Bool = false) -> String {
        let value = Int(seconds.rounded(.down))
        let day = ((value % 86400) + 86400) % 86400
        let hour = day / 3600, minute = (day % 3600) / 60
        if twelveHour { return String(format: "%d:%02d %@", hour % 12 == 0 ? 12 : hour % 12, minute, hour < 12 ? "AM" : "PM") }
        return String(format: "%02d:%02d", hour, minute)
    }
}

public struct ScheduleFrame: Sendable {
    public let dateKey: String
    public let today: String
    public let seconds: Double
    public let live: Bool
}

public struct ScheduledDeparture: Identifiable, Sendable {
    public var departure: Departure
    public var serviceDate: String
    public var delay: Double
    public var delta: Double
    public var live: Bool
    public var hasLiveTiming: Bool
    public var boatName: String?
    public var predictedBoatName: String?
    /// The slip a current Ferry RT feed confirmed for this call.
    public var slipName: String?
    public var isLastOfDay: Bool = false
    public var isLastGovernorsIsland: Bool = false
    public var id: String { "\(serviceDate)|\(departure.tripId)|\(departure.stopId)|\(departure.seconds)" }

    public var relativeTime: String {
        guard live else { return "" }
        if delta <= 90 { return "Boarding" }
        if delta < 3600 { return "\(Int(ceil(delta / 60))) min" }
        if delta < 86400 { return "\(Int(delta / 3600)) hr \(Int(ceil(delta.truncatingRemainder(dividingBy: 3600) / 60))) min" }
        return "Tomorrow"
    }
}

public struct DepartureGroup: Identifiable, Sendable {
    public var id: String
    public var routeId: String
    public var variant: String?
    public var directionId: String?
    public var destination: String
    public var departures: [ScheduledDeparture]
}

public struct LayoverTiming: Sendable, Equatable {
    public let scheduledSeconds: Double
    public let estimatedSeconds: Double?
    public var hasLiveTiming: Bool { estimatedSeconds != nil }
    public var seconds: Double { estimatedSeconds ?? scheduledSeconds }
    // Match JavaScript Math.round, including negative half-minute overruns.
    public var scheduledMinutes: Int { Int(floor(scheduledSeconds / 60 + 0.5)) }
    public var estimatedMinutes: Int? { estimatedSeconds.map { Int(floor($0 / 60 + 0.5)) } }
    public var minutes: Int { estimatedMinutes ?? scheduledMinutes }
}

public struct DeparturePauses: Sendable, Equatable {
    public var dwellSeconds: Double?
    public var layover: LayoverTiming?
    public var dwellMinutes: Int? { dwellSeconds.map { Int(floor($0 / 60 + 0.5)) } }
}

/// Swift implementation of public/assets/schedule.js. Both implementations run the same fixtures.
public enum ScheduleEngine {
    public static func frame(_ data: DisplayData, viewDate: String? = nil, now: Date) -> ScheduleFrame {
        let p = ServiceClock.parts(now, timezone: data.meta.timezone)
        let live = viewDate == nil || viewDate == p.dateKey
        return ScheduleFrame(dateKey: live ? p.dateKey : viewDate!, today: p.dateKey, seconds: live ? p.seconds : 0, live: live)
    }

    public static func activeServices(_ data: DisplayData, date: String) -> Set<String> {
        guard let instant = ServiceClock.date(date) else { return [] }
        let weekday = ServiceClock.calendar("UTC").component(.weekday, from: instant) - 1
        var result = Set(data.calendars.filter {
            date >= $0.startDate && date <= $0.endDate && $0.weekdays.indices.contains(weekday) && $0.weekdays[weekday]
        }.map(\.serviceId))
        for exception in data.exceptions where exception.date == date {
            if exception.added { result.insert(exception.serviceId) } else { result.remove(exception.serviceId) }
        }
        return result
    }

    public static func range(_ data: DisplayData) -> ClosedRange<String>? {
        let additions = data.exceptions.filter(\.added).map(\.date)
        guard let first = (data.calendars.map(\.startDate) + additions).min(),
              let last = (data.calendars.map(\.endDate) + additions).max() else { return nil }
        return first...last
    }

    public static func crewCoverage(_ data: DisplayData, date: String) -> CrewCoverage? {
        if let holiday = data.meta.crewScheduleStatus?.confirmedHolidays, holiday.dates.contains(date) {
            return CrewCoverage(startDate: date, endDate: date, message: holiday.message)
        }
        guard let instant = ServiceClock.date(date) else { return nil }
        let day = ServiceClock.calendar("UTC").component(.weekday, from: instant)
        if let reviewed = day == 1 || day == 7 ? data.meta.crewScheduleStatus?.reviewedWeekends : data.meta.crewScheduleStatus?.reviewedWeekdays,
           date >= reviewed.startDate, date <= reviewed.endDate,
           !(reviewed.excludedDates ?? []).contains(date) { return reviewed }
        let coverage = day == 1 || day == 7 ? data.meta.crewScheduleStatus?.confirmedWeekends : data.meta.crewScheduleStatus?.confirmedWeekdays
        guard let coverage, date >= coverage.startDate, date <= coverage.endDate,
              !(coverage.excludedDates ?? []).contains(date) else { return nil }
        return coverage
    }

    /// The staff board's dwell and terminal layover rules in public/app.js.
    public static func departurePauses(data: DisplayData, row: ScheduledDeparture, realtime: Realtime) -> DeparturePauses {
        let departure = row.departure
        var result = DeparturePauses()
        guard departure.outOfService != true, departure.crewShuttle != true,
              departure.endsShift?.isEmpty != false else { return result }
        let trip = data.tripSchedules[departure.tripId] ?? departure.liveTripId.flatMap { data.tripSchedules[$0] }
        if data.meta.showDwellTimes == true,
           let stop = trip?.stops.first(where: { $0.stopId == departure.stopId }),
           let arrival = stop.arrivalSeconds, let leaving = stop.departureSeconds {
            let dwell = leaving - arrival
            if dwell.isFinite && dwell >= 0 { result.dwellSeconds = dwell }
        }
        guard data.meta.showLayoverTimes != false, let turn = trip?.turnaround,
              let scheduled = turn.scheduledLayoverSeconds, scheduled.isFinite else { return result }
        let updates = row.live && !realtime.stale && !(departure.scheduleOnly == true && departure.liveTripId == nil) ? realtime.updates ?? [] : []
        let arrivingID = departure.liveTripId ?? trip?.liveTripId ?? departure.tripId
        let leavingID = turn.nextLiveTripIdsByDate?[row.serviceDate] ?? turn.nextLiveTripId
            ?? turn.nextTripId.flatMap { data.tripSchedules[$0]?.liveTripIdsByDate?[row.serviceDate] ?? data.tripSchedules[$0]?.liveTripId }
            ?? turn.nextTripId
        let arrival = updates.first { $0.tripId == arrivingID && $0.stopId == turn.stopId }
        let next = updates.first { $0.tripId == leavingID && $0.stopId == turn.stopId }
        func delay(_ update: TripUpdate?, arrival: Bool = false) -> Double? {
            guard let value = arrival ? update?.arrivalDelaySeconds ?? update?.delaySeconds : update?.delaySeconds,
                  value.isFinite else { return nil }
            return max(0, value)
        }
        let arrivalDelay = delay(arrival, arrival: true), nextDelay = delay(next)
        let live = arrival?.canceled != true && next?.canceled != true && (arrivalDelay != nil || nextDelay != nil)
        // A negative value represents an overrun of the scheduled turn and is useful to crew.
        let estimate = live ? scheduled - (arrivalDelay ?? 0) + (nextDelay ?? 0) : nil
        guard estimate?.isFinite != false else { return result }
        result.layover = LayoverTiming(scheduledSeconds: scheduled, estimatedSeconds: estimate)
        return result
    }

    /// A connection response may enrich the terminal's scheduled turn; stale snapshots cannot.
    public static func tripLayover(data: DisplayData, tripID: String, call: TripCall,
                                   connectionTurnaround: Turnaround? = nil, live: Bool = false) -> LayoverTiming? {
        guard data.meta.showLayoverTimes != false else { return nil }
        let trip = data.tripSchedules[tripID]
        let local = call.sequence == trip?.stops.map(\.sequence).max() && call.stopId == trip?.turnaround?.stopId
            ? trip?.turnaround : nil
        guard let turn = connectionTurnaround ?? local,
              let scheduled = turn.scheduledSeconds ?? turn.scheduledLayoverSeconds, scheduled.isFinite else { return nil }
        let estimate = live && turn.hasLiveTiming == true && turn.estimatedSeconds?.isFinite == true ? turn.estimatedSeconds : nil
        return LayoverTiming(scheduledSeconds: scheduled, estimatedSeconds: estimate)
    }

    private static func ordered(_ left: DepartureGroup, _ right: DepartureGroup) -> Bool {
        func comparison(_ a: String, _ b: String) -> ComparisonResult {
            a.compare(b, options: [.caseInsensitive], locale: Locale(identifier: "en_US"))
        }
        if left.routeId != right.routeId { return comparison(left.routeId, right.routeId) == .orderedAscending }
        let variants = ["A": 0, "B": 1, "LOCAL": 2]
        let l = variants[left.variant ?? ""] ?? 3, r = variants[right.variant ?? ""] ?? 3
        if l != r { return l < r }
        if left.directionId != right.directionId { return (left.directionId ?? "undefined") < (right.directionId ?? "undefined") }
        return comparison(left.destination, right.destination) == .orderedAscending
    }

    public static func groups(data: DisplayData, realtime: Realtime = .empty, viewDate: String? = nil,
                              now: Date, limitPerGroup: Int? = nil) -> [DepartureGroup] {
        let frame = frame(data, viewDate: viewDate, now: now)
        var updates: [String: TripUpdate] = [:], vehicles: [String: VehicleAssignment] = [:], vessels: [String: VehicleAssignment] = [:]
        if frame.live {
            for update in realtime.updates ?? [] { updates["\(update.tripId)|\(update.stopId)"] = update }
            for vehicle in realtime.vehicles ?? [] {
                vehicles[vehicle.tripId] = vehicle
                if let boat = vehicle.boat, vehicle.boatName != nil,
                   (vehicle.updatedAtEpochSeconds ?? 0) >= (vessels[boat]?.updatedAtEpochSeconds ?? 0) { vessels[boat] = vehicle }
            }
        }
        var groups: [String: DepartureGroup] = [:], order: [String] = []
        var last: [String: (String, Double)] = [:], islandLast: [String: (String, Double)] = [:]
        func slot(_ departure: Departure) -> String { "\(departure.routeId)|\(departure.variant ?? "")|\(departure.directionId ?? "undefined")" }
        for offset in -1...0 {
            let serviceDate = ServiceClock.addDays(frame.dateKey, offset)
            let active = activeServices(data, date: serviceDate)
            for original in data.departures where active.contains(original.serviceId) {
                var departure = original
                departure.liveTripId = original.liveTripIdsByDate?[serviceDate] ?? original.liveTripId
                departure.predictTripId = original.predictTripIdsByDate?[serviceDate] ?? original.predictTripId
                guard ServiceClock.addDays(serviceDate, Int(floor(departure.seconds / 86400))) == frame.dateKey else { continue }
                let timetableOnly = departure.scheduleOnly == true && departure.liveTripId == nil
                let liveTripID = departure.liveTripId ?? departure.tripId
                let update = timetableOnly ? nil : updates["\(liveTripID)|\(departure.stopId)"]
                if update?.canceled == true { continue }
                let fresh = !realtime.stale && update?.delaySeconds?.isFinite == true
                let delay = fresh ? max(0, update!.delaySeconds!) : 0
                let scheduledMoment = Double(offset) * 86400 + departure.seconds
                let delta = scheduledMoment + delay - frame.seconds
                let key = slot(departure)
                let passenger = departure.outOfService != true && departure.crewShuttle != true && departure.arrival != true
                if passenger && (last[key] == nil || scheduledMoment > last[key]!.1) { last[key] = (departure.tripId, scheduledMoment) }
                if departure.routeId == "SB", departure.servesGovernorsIsland == true,
                   islandLast[key] == nil || scheduledMoment > islandLast[key]!.1 { islandLast[key] = (departure.tripId, scheduledMoment) }
                guard delta >= -60 else { continue }
                let groupKey = "\(key)|\(departure.destination)|\((departure.via ?? []).joined(separator: " > "))"
                if groups[groupKey] == nil {
                    order.append(groupKey)
                    groups[groupKey] = DepartureGroup(id: groupKey, routeId: departure.routeId, variant: departure.variant,
                                                       directionId: departure.directionId, destination: departure.destination, departures: [])
                }
                if data.meta.crewScheduleStatus != nil && crewCoverage(data, date: serviceDate) == nil { departure.endsShift = nil }
                let boatName = timetableOnly ? nil : vehicles[liveTripID]?.boatName
                var prediction: String?
                if !timetableOnly && boatName == nil {
                    prediction = departure.predictTripId.flatMap { vehicles[$0]?.boatName }
                    if prediction == nil, let assignment = departure.boatAssignment {
                        prediction = vessels["\(departure.routeId)\(assignment)"]?.boatName
                    }
                }
                groups[groupKey]!.departures.append(ScheduledDeparture(departure: departure, serviceDate: serviceDate, delay: delay,
                    delta: delta, live: frame.live, hasLiveTiming: fresh, boatName: boatName, predictedBoatName: prediction,
                    slipName: realtime.stale ? nil : update?.slip?.name))
            }
        }
        let window = Double(data.meta.departureWindowMinutes == 0 ? 180 : data.meta.departureWindowMinutes) * 60
        return order.compactMap { groups[$0] }.compactMap { original in
            var group = original
            group.departures = group.departures.enumerated().sorted {
                $0.element.delta == $1.element.delta ? $0.offset < $1.offset : $0.element.delta < $1.element.delta
            }.map { _, original in
                var row = original
                row.isLastOfDay = last[slot(row.departure)]?.0 == row.departure.tripId
                row.isLastGovernorsIsland = row.departure.servesGovernorsIsland == true && islandLast[slot(row.departure)]?.0 == row.departure.tripId
                return row
            }
            if frame.live && (group.departures.first?.delta ?? .infinity) > window { return nil }
            if let limitPerGroup { group.departures = Array(group.departures.prefix(limitPerGroup)) }
            return group
        }.sorted(by: ordered)
    }

    public static func timeline(data: DisplayData, realtime: Realtime = .empty, viewDate: String? = nil, now: Date) -> [ScheduledDeparture] {
        let frame = frame(data, viewDate: viewDate, now: now)
        let window = Double(data.meta.departureWindowMinutes == 0 ? 180 : data.meta.departureWindowMinutes) * 60
        // Flattening already sorted groups provides the web engine's stable route tiebreak.
        return groups(data: data, realtime: realtime, viewDate: viewDate, now: now)
            .flatMap(\.departures).filter { !frame.live || $0.delta <= window }
            .enumerated().sorted { $0.element.delta == $1.element.delta ? $0.offset < $1.offset : $0.element.delta < $1.element.delta }.map(\.element)
    }
}
