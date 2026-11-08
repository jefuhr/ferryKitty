import Foundation

public struct Landing: Codable, Identifiable, Sendable {
    public var id: Int
    public var name: String
    public var displayName: String
    public var latitude: Double?
    public var longitude: Double?
}

public struct LandingRoster: Codable, Sendable {
    public var landings: [Landing]
    public var operators: [String]
    public var routes: [String: FerryRoute]?
    public var configured: Int
}

public struct LandingInfo: Codable, Sendable {
    public var name: String?
    public var displayName: String
    public var stopIds: [String]?
    public var latitude: Double?
    public var longitude: Double?
}

public struct CrewCoverage: Codable, Sendable {
    public var startDate: String
    public var endDate: String
    public var excludedDates: [String]?
    public var message: String?
}

public struct CrewStatus: Codable, Sendable {
    public var status: String?
    public var message: String?
    public var reviewedWeekends: CrewCoverage?
    public var reviewedWeekdays: CrewCoverage?
    public var confirmedWeekdays: CrewCoverage?
    public var confirmedWeekends: CrewCoverage?
    public var confirmedHolidays: HolidayCrewCoverage?
}

public struct HolidayCrewCoverage: Codable, Sendable {
    public var dates: [String]
    public var message: String?
}

public struct HolidaySchedule: Codable, Sendable {
    public var dates: [String]
    public var message: String
}

public struct ScheduleMetadata: Codable, Sendable {
    public var schemaVersion: Int
    public var generatedAt: String?
    public var landingNumber: Int
    public var landing: LandingInfo
    public var timezone: String
    public var agencyName: String?
    public var departureWindowMinutes: Int
    public var departuresShown: Int
    public var feedStartDate: String?
    public var feedEndDate: String?
    public var crewScheduleStatus: CrewStatus?
    public var holidaySchedule: HolidaySchedule?
    public var showDwellTimes: Bool?
    public var showLayoverTimes: Bool?
}

public struct ServiceCalendar: Codable, Sendable {
    public var serviceId: String
    public var startDate: String
    public var endDate: String
    public var weekdays: [Bool]
}

public struct CalendarException: Codable, Sendable {
    public var serviceId: String
    public var date: String
    public var added: Bool
}

public struct FerryRoute: Codable, Sendable {
    public var id: String?
    public var name: String
    public var shortName: String?
    public var color: String?
    public var textColor: String?
    public var mode: String?
    public var `operator`: String?
}

public struct ViaTerminal: Codable, Sendable {
    public var code: String
    public var name: String?
}

public struct Departure: Codable, Sendable {
    public var tripId: String
    public var routeId: String
    public var serviceId: String
    public var stopId: String
    public var directionId: String?
    public var destination: String
    public var seconds: Double
    public var departureTime: String
    public var variant: String?
    public var boatAssignment: Int?
    public var via: [String]?
    public var viaTerminals: [ViaTerminal]?
    public var mode: String?
    public var `operator`: String?
    public var endsShift: String?
    public var endsDay: Bool?
    public var outOfService: Bool?
    public var fromHomePort: Bool?
    public var crewShuttle: Bool?
    public var arrival: Bool?
    public var approximate: Bool?
    public var servesGovernorsIsland: Bool?
    public var liveTripId: String?
    public var predictTripId: String?
    public var liveTripIdsByDate: [String: String]?
    public var predictTripIdsByDate: [String: String]?
    public var departureTimeEnd: String?
    public var secondsEnd: Double?
    public var crewBoats: [String]?
    public var scheduleOnly: Bool?
    public var timetableOnly: Bool?
}

public struct TripCall: Codable, Identifiable, Sendable {
    public var stopId: String
    public var sequence: Int
    public var arrivalSeconds: Double?
    public var feedArrivalSeconds: Double?
    public var departureSeconds: Double?
    public var pickupType: Int?
    public var dropOffType: Int?
    public var id: Int { sequence }
}

public struct Turnaround: Codable, Sendable {
    public var stopId: String?
    public var nextTripId: String?
    public var nextLiveTripId: String?
    public var nextLiveTripIdsByDate: [String: String]?
    public var scheduledLayoverSeconds: Double?
    public var scheduledSeconds: Double?
    public var estimatedSeconds: Double?
    public var hasLiveTiming: Bool?
}

public struct TripSchedule: Codable, Sendable {
    public var stops: [TripCall]
    public var liveTripId: String?
    public var liveTripIdsByDate: [String: String]?
    public var serviceId: String?
    public var routeId: String?
    public var boatAssignment: Int?
    public var turnaround: Turnaround?
    public var timetableOnly: Bool?
}

public struct StopInfo: Codable, Sendable {
    public var name: String
    public var landingId: Int?
}

public struct DisplayData: Codable, Sendable {
    public var meta: ScheduleMetadata
    public var calendars: [ServiceCalendar]
    public var exceptions: [CalendarException]
    public var routes: [String: FerryRoute]
    public var departures: [Departure]
    public var tripSchedules: [String: TripSchedule]
    public var stops: [String: StopInfo]?

    public func validate(landingID: Int? = nil) throws {
        guard meta.schemaVersion == 11 else { throw FerryError.unsupportedSchedule(meta.schemaVersion) }
        guard landingID == nil || meta.landingNumber == landingID else { throw FerryError.wrongIdentity }
        guard TimeZone(identifier: meta.timezone) != nil,
              (1...5).contains(meta.departuresShown), meta.departureWindowMinutes > 0,
              calendars.allSatisfy({ $0.weekdays.count == 7 }),
              departures.allSatisfy({ $0.seconds.isFinite && $0.seconds >= 0 }) else {
            throw FerryError.invalidResponse
        }
    }
}

public struct TripUpdate: Codable, Sendable {
    public var tripId: String
    public var stopId: String
    public var delaySeconds: Double?
    public var arrivalDelaySeconds: Double?
    public var canceled: Bool?
    /// The exact boarding slip Ferry RT confirmed; filled in on the device, never by the board's server.
    public var slip: Slip?
}

public struct Slip: Codable, Sendable, Hashable {
    public var id: String
    public var name: String
}

public struct VehicleAssignment: Codable, Sendable {
    public var tripId: String
    public var boat: String?
    public var boatName: String?
    public var updatedAtEpochSeconds: Double?
    public var vesselId: String?
}

public struct Realtime: Codable, Sendable {
    public var available: Bool?
    public var stale: Bool
    public var fetchedAt: String?
    public var vehiclesStale: Bool?
    public var updates: [TripUpdate]?
    public var vehicles: [VehicleAssignment]?
    public static var empty: Self { Self(available: false, stale: true, updates: [], vehicles: []) }
}

public struct ServiceAlert: Codable, Identifiable, Sendable {
    public var id: String?
    public var header: String?
    public var description: String?
    public var agency: String?
    public var url: String?
    public var routeIds: [String]?
    public var stopIds: [String]?
}

public struct Alerts: Codable, Sendable {
    public var available: Bool
    public var stale: Bool
    public var fetchedAt: String?
    public var partial: Bool?
    public var alerts: [ServiceAlert]
}

public struct MapBounds: Codable, Sendable {
    public var minLatitude: Double
    public var maxLatitude: Double
    public var minLongitude: Double
    public var maxLongitude: Double
}

public struct MapRoute: Codable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var shortName: String?
    public var color: String?
    public var paths: [[[Double]]]?
}

public struct Bridge: Codable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var waterway: String?
    public var type: String?
    public var clearanceFeet: Double?
    public var clearanceNote: String?
    public var points: [[Double]]
}

public struct Seamark: Codable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var latitude: Double
    public var longitude: Double
    public var type: String?
    public var characteristic: String?
    public var rangeNm: Double?
    public var description: String?
}

public struct HarborChart: Codable, Sendable {
    public var bridges: [Bridge]?
    public var seamarks: [Seamark]?
}

public struct Harbor: Codable, Sendable {
    public var bounds: MapBounds
    public var routes: [MapRoute]
    public var landings: [Landing]
    public var chart: HarborChart?
}

public struct BoatStop: Codable, Sendable {
    public var name: String?
    public var latitude: Double?
    public var longitude: Double?
}

public struct Boat: Codable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var number: String?
    public var vesselId: String?
    public var tripId: String?
    public var latitude: Double
    public var longitude: Double
    public var bearing: Double?
    public var speedKnots: Double?
    public var ageSeconds: Double?
    public var routeId: String?
    public var route: String?
    public var routeName: String?
    public var color: String?
    public var status: String?
    public var stop: BoatStop?
    public var destination: String?
    public var mode: String?
}

public struct Boats: Codable, Sendable {
    public var available: Bool
    public var stale: Bool
    public var fetchedAt: String?
    public var boats: [Boat]
}

public struct Connection: Codable, Identifiable, Sendable {
    public var tripId: String
    public var routeId: String
    public var shortName: String?
    public var departureTime: String
    public var seconds: Double
    public var delaySeconds: Double?
    public var hasLiveTiming: Bool?
    public var boatName: String?
    public var predictedBoatName: String?
    public var destination: String
    public var `operator`: String?
    public var color: String?
    public var id: String { "\(tripId)|\(seconds)|\(destination)" }
}

public struct ConnectionStop: Codable, Identifiable, Sendable {
    public var stopId: String
    public var landingId: Int?
    public var name: String
    public var sequence: Int
    public var arrivalSeconds: Double?
    public var departureSeconds: Double?
    public var estimatedArrivalSeconds: Double?
    public var turnaround: Turnaround?
    public var limit: Int?
    public var connections: [Connection]
    public var id: Int { sequence }
}

public struct Connections: Codable, Sendable {
    public var tripId: String
    public var generatedAt: String?
    public var serviceDate: String
    public var stale: Bool
    public var stops: [ConnectionStop]

    public func usable(tripID: String, serviceDate: String, now: Date) -> Bool {
        guard tripId == tripID, self.serviceDate == serviceDate,
              let generatedAt, let date = ServiceClock.instant(generatedAt) else { return false }
        return (-60...300).contains(now.timeIntervalSince(date))
    }
}

public struct Vessel: Codable, Identifiable, Sendable, Equatable {
    public var id: String
    public var name: String
    public var number: String?
    public init(id: String, name: String, number: String? = nil) {
        self.id = id; self.name = name; self.number = number
    }
}

public struct Vessels: Codable, Sendable { public var vessels: [Vessel] }

public struct RidePosition: Codable, Sendable {
    public var vesselId: String
    public var latitude: Double
    public var longitude: Double
    public var reportedAt: Double
    public var speedKnots: Double?
    public var status: String?
}

public struct RideStop: Codable, Identifiable, Sendable {
    public var stopId: String
    public var sequence: Int
    public var name: String
    public var landingId: Int?
    public var arrivalSeconds: Double?
    public var feedArrivalSeconds: Double?
    public var departureSeconds: Double?
    public var pickupType: Int?
    public var dropOffType: Int?
    public var estimatedArrivalSeconds: Double?
    public var estimatedDepartureSeconds: Double?
    public var arrivalAt: Double?
    public var departureAt: Double?
    public var layoverSeconds: Double?
    public var layoverEstimated: Bool?
    public var skipped: Bool
    public var current: Bool
    public var past: Bool
    public var id: Int { sequence }

    /// Wire instants are epoch milliseconds. Cached estimates must lose their former offset.
    public func instant(arrival: Bool, stale: Bool) -> Date? {
        guard var at = arrival ? arrivalAt : departureAt else { return nil }
        let scheduled = arrival ? arrivalSeconds : departureSeconds
        let estimate = arrival ? estimatedArrivalSeconds : estimatedDepartureSeconds
        if stale, let scheduled, let estimate { at += (scheduled - estimate) * 1000 }
        return Date(timeIntervalSince1970: at / 1000)
    }
}

public struct RideTrip: Codable, Identifiable, Sendable {
    public var tripId: String
    public var serviceDate: String
    public var routeId: String?
    public var route: String
    public var boatAssignment: Int?
    public var destination: String
    public var state: String
    public var confirmedAt: Double
    public var outOfService: Bool?
    public var startAt: Double?
    public var stops: [RideStop]
    public var id: String { "\(serviceDate)|\(tripId)" }
}

public struct Ride: Codable, Sendable {
    public var vessel: Vessel
    public var date: String
    public var timezone: String
    public var generatedAt: String
    public var fetchedAt: String?
    public var stale: Bool
    public var positionStale: Bool
    public var position: RidePosition?
    public var nextStop: RideStop?
    public var trips: [RideTrip]
    public var historyNote: String
}

public struct ChangelogEntry: Codable, Sendable {
    public var version: String?
    public var date: String
    public var title: String
    public var notes: [String]
}
public struct Changelog: Codable, Sendable { public var entries: [ChangelogEntry] }
