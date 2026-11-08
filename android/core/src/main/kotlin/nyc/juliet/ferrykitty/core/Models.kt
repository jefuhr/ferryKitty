package nyc.juliet.ferrykitty.core

import kotlinx.serialization.Serializable

// Wire fields mirror iOS FerryCore. Unknown additive fields remain in the original-byte cache.

@Serializable
data class Landing(
	val id: Int,
	val name: String,
	val displayName: String,
	val latitude: Double? = null,
	val longitude: Double? = null,
)

@Serializable
data class LandingRoster(
	val landings: List<Landing>,
	val operators: List<String>,
	val routes: Map<String, FerryRoute>? = null,
	val configured: Int,
)

@Serializable
data class LandingInfo(
	val name: String? = null,
	val displayName: String,
	val stopIds: List<String>? = null,
	val latitude: Double? = null,
	val longitude: Double? = null,
)

@Serializable
data class CrewCoverage(
	val startDate: String,
	val endDate: String,
	val excludedDates: List<String>? = null,
	val message: String? = null,
)

@Serializable
data class CrewStatus(
	val status: String? = null,
	val message: String? = null,
	val reviewedWeekends: CrewCoverage? = null,
	val reviewedWeekdays: CrewCoverage? = null,
	val confirmedWeekdays: CrewCoverage? = null,
	val confirmedWeekends: CrewCoverage? = null,
	val confirmedHolidays: HolidayCrewCoverage? = null,
)

@Serializable
data class HolidayCrewCoverage(
	val dates: List<String>,
	val message: String? = null,
)

@Serializable
data class HolidaySchedule(
	val dates: List<String>,
	val message: String,
)

@Serializable
data class ScheduleMetadata(
	val schemaVersion: Int,
	val generatedAt: String? = null,
	val landingNumber: Int,
	val landing: LandingInfo,
	val timezone: String,
	val agencyName: String? = null,
	val departureWindowMinutes: Int,
	val departuresShown: Int,
	val feedStartDate: String? = null,
	val feedEndDate: String? = null,
	val crewScheduleStatus: CrewStatus? = null,
	val holidaySchedule: HolidaySchedule? = null,
	val showDwellTimes: Boolean? = null,
	val showLayoverTimes: Boolean? = null,
)

@Serializable
data class ServiceCalendar(
	val serviceId: String,
	val startDate: String,
	val endDate: String,
	val weekdays: List<Boolean>,
)

@Serializable
data class CalendarException(
	val serviceId: String,
	val date: String,
	val added: Boolean,
)

@Serializable
data class FerryRoute(
	val id: String? = null,
	val name: String,
	val shortName: String? = null,
	val color: String? = null,
	val textColor: String? = null,
	val mode: String? = null,
	val `operator`: String? = null,
)

@Serializable
data class ViaTerminal(
	val code: String,
	val name: String? = null,
)

@Serializable
data class Departure(
	val tripId: String,
	val routeId: String,
	val serviceId: String,
	val stopId: String,
	val directionId: String? = null,
	val destination: String,
	val seconds: Double,
	val departureTime: String,
	val variant: String? = null,
	val boatAssignment: Int? = null,
	val via: List<String>? = null,
	val viaTerminals: List<ViaTerminal>? = null,
	val mode: String? = null,
	val `operator`: String? = null,
	val endsShift: String? = null,
	val endsDay: Boolean? = null,
	val outOfService: Boolean? = null,
	val fromHomePort: Boolean? = null,
	val crewShuttle: Boolean? = null,
	val arrival: Boolean? = null,
	val approximate: Boolean? = null,
	val servesGovernorsIsland: Boolean? = null,
	val liveTripId: String? = null,
	val predictTripId: String? = null,
	val liveTripIdsByDate: Map<String, String>? = null,
	val predictTripIdsByDate: Map<String, String>? = null,
	val departureTimeEnd: String? = null,
	val secondsEnd: Double? = null,
	val crewBoats: List<String>? = null,
	val scheduleOnly: Boolean? = null,
	val timetableOnly: Boolean? = null,
)

@Serializable
data class TripCall(
	val stopId: String,
	val sequence: Int,
	val arrivalSeconds: Double? = null,
	val feedArrivalSeconds: Double? = null,
	val departureSeconds: Double? = null,
	val pickupType: Int? = null,
	val dropOffType: Int? = null,
) {
	val id: Int get() = sequence
}

@Serializable
data class Turnaround(
	val stopId: String? = null,
	val nextTripId: String? = null,
	val nextLiveTripId: String? = null,
	val nextLiveTripIdsByDate: Map<String, String>? = null,
	val scheduledLayoverSeconds: Double? = null,
	val scheduledSeconds: Double? = null,
	val estimatedSeconds: Double? = null,
	val hasLiveTiming: Boolean? = null,
)

@Serializable
data class TripSchedule(
	val stops: List<TripCall>,
	val liveTripId: String? = null,
	val liveTripIdsByDate: Map<String, String>? = null,
	val serviceId: String? = null,
	val routeId: String? = null,
	val boatAssignment: Int? = null,
	val turnaround: Turnaround? = null,
	val timetableOnly: Boolean? = null,
)

@Serializable
data class StopInfo(
	val name: String,
	val landingId: Int? = null,
)

@Serializable
data class DisplayData(
	val meta: ScheduleMetadata,
	val calendars: List<ServiceCalendar>,
	val exceptions: List<CalendarException>,
	val routes: Map<String, FerryRoute>,
	val departures: List<Departure>,
	val tripSchedules: Map<String, TripSchedule>,
	val stops: Map<String, StopInfo>? = null,
) {
	fun validate(landingId: Int? = null) {
		if (meta.schemaVersion != 11) throw FerryError.UnsupportedSchedule(meta.schemaVersion)
		if (landingId != null && meta.landingNumber != landingId) throw FerryError.WrongIdentity()
		if (!ServiceClock.validTimezone(meta.timezone) || meta.departuresShown !in 1..5 || meta.departureWindowMinutes <= 0 ||
			calendars.any { it.weekdays.size != 7 } || departures.any { !it.seconds.isFinite() || it.seconds < 0 }) {
			throw FerryError.InvalidResponse()
		}
	}
}

@Serializable
data class TripUpdate(
	val tripId: String,
	val stopId: String,
	val delaySeconds: Double? = null,
	val arrivalDelaySeconds: Double? = null,
	val canceled: Boolean? = null,
)

@Serializable
data class VehicleAssignment(
	val tripId: String,
	val boat: String? = null,
	val boatName: String? = null,
	val updatedAtEpochSeconds: Double? = null,
	val vesselId: String? = null,
)

@Serializable
data class Realtime(
	val available: Boolean? = null,
	val stale: Boolean,
	val fetchedAt: String? = null,
	val vehiclesStale: Boolean? = null,
	val updates: List<TripUpdate>? = null,
	val vehicles: List<VehicleAssignment>? = null,
) {
	companion object { val empty = Realtime(available = false, stale = true, updates = emptyList(), vehicles = emptyList()) }
}

@Serializable
data class ServiceAlert(
	val id: String? = null,
	val header: String? = null,
	val description: String? = null,
	val agency: String? = null,
	val url: String? = null,
	val routeIds: List<String>? = null,
	val stopIds: List<String>? = null,
)

@Serializable
data class Alerts(
	val available: Boolean,
	val stale: Boolean,
	val fetchedAt: String? = null,
	val partial: Boolean? = null,
	val alerts: List<ServiceAlert>,
)

@Serializable
data class MapBounds(
	val minLatitude: Double,
	val maxLatitude: Double,
	val minLongitude: Double,
	val maxLongitude: Double,
)

@Serializable
data class MapRoute(
	val id: String,
	val name: String,
	val shortName: String? = null,
	val color: String? = null,
	val paths: List<List<List<Double>>>? = null,
)

@Serializable
data class Bridge(
	val id: String,
	val name: String,
	val waterway: String? = null,
	val type: String? = null,
	val clearanceFeet: Double? = null,
	val clearanceNote: String? = null,
	val points: List<List<Double>>,
)

@Serializable
data class Seamark(
	val id: String,
	val name: String,
	val latitude: Double,
	val longitude: Double,
	val type: String? = null,
	val characteristic: String? = null,
	val rangeNm: Double? = null,
	val description: String? = null,
)

@Serializable
data class HarborChart(
	val bridges: List<Bridge>? = null,
	val seamarks: List<Seamark>? = null,
)

@Serializable
data class Harbor(
	val bounds: MapBounds,
	val routes: List<MapRoute>,
	val landings: List<Landing>,
	val chart: HarborChart? = null,
)

@Serializable
data class BoatStop(
	val name: String? = null,
	val latitude: Double? = null,
	val longitude: Double? = null,
)

@Serializable
data class Boat(
	val id: String,
	val name: String,
	val number: String? = null,
	val vesselId: String? = null,
	val tripId: String? = null,
	val latitude: Double,
	val longitude: Double,
	val bearing: Double? = null,
	val speedKnots: Double? = null,
	val ageSeconds: Double? = null,
	val routeId: String? = null,
	val route: String? = null,
	val routeName: String? = null,
	val color: String? = null,
	val status: String? = null,
	val stop: BoatStop? = null,
	val destination: String? = null,
	val mode: String? = null,
)

@Serializable
data class Boats(
	val available: Boolean,
	val stale: Boolean,
	val fetchedAt: String? = null,
	val boats: List<Boat>,
)

@Serializable
data class Connection(
	val tripId: String,
	val routeId: String,
	val shortName: String? = null,
	val departureTime: String,
	val seconds: Double,
	val delaySeconds: Double? = null,
	val hasLiveTiming: Boolean? = null,
	val boatName: String? = null,
	val predictedBoatName: String? = null,
	val destination: String,
	val `operator`: String? = null,
	val color: String? = null,
) {
	val id: String get() = "$tripId|$seconds|$destination"
}

@Serializable
data class ConnectionStop(
	val stopId: String,
	val landingId: Int? = null,
	val name: String,
	val sequence: Int,
	val arrivalSeconds: Double? = null,
	val departureSeconds: Double? = null,
	val estimatedArrivalSeconds: Double? = null,
	val turnaround: Turnaround? = null,
	val limit: Int? = null,
	val connections: List<Connection>,
) {
	val id: Int get() = sequence
}

@Serializable
data class Connections(
	val tripId: String,
	val generatedAt: String? = null,
	val serviceDate: String,
	val stale: Boolean,
	val stops: List<ConnectionStop>,
) {
	fun usable(tripId: String, serviceDate: String, now: java.time.Instant): Boolean {
		val generated = ServiceClock.instant(generatedAt) ?: return false
		return this.tripId == tripId && this.serviceDate == serviceDate && ServiceClock.elapsed(generated, now) in -60.0..300.0
	}
}

@Serializable
data class Vessel(
	val id: String,
	val name: String,
	val number: String? = null,
)

@Serializable
data class Vessels(
	val vessels: List<Vessel>,
)

@Serializable
data class RidePosition(
	val vesselId: String,
	val latitude: Double,
	val longitude: Double,
	val reportedAt: Double,
	val speedKnots: Double? = null,
	val status: String? = null,
)

@Serializable
data class RideStop(
	val stopId: String,
	val sequence: Int,
	val name: String,
	val landingId: Int? = null,
	val arrivalSeconds: Double? = null,
	val feedArrivalSeconds: Double? = null,
	val departureSeconds: Double? = null,
	val pickupType: Int? = null,
	val dropOffType: Int? = null,
	val estimatedArrivalSeconds: Double? = null,
	val estimatedDepartureSeconds: Double? = null,
	val arrivalAt: Double? = null,
	val departureAt: Double? = null,
	val layoverSeconds: Double? = null,
	val layoverEstimated: Boolean? = null,
	val skipped: Boolean,
	val current: Boolean,
	val past: Boolean,
) {
	val id: Int get() = sequence
	/** Wire instants are epoch milliseconds; stale estimates lose their own offset. */
	fun instant(arrival: Boolean, stale: Boolean): java.time.Instant? {
		var at = (if (arrival) arrivalAt else departureAt) ?: return null
		val scheduled = if (arrival) arrivalSeconds else departureSeconds
		val estimate = if (arrival) estimatedArrivalSeconds else estimatedDepartureSeconds
		if (stale && scheduled != null && estimate != null) at += (scheduled - estimate) * 1000
		return ServiceClock.fromEpochSeconds(at / 1000)
	}
}

@Serializable
data class RideTrip(
	val tripId: String,
	val serviceDate: String,
	val routeId: String? = null,
	val route: String,
	val boatAssignment: Int? = null,
	val destination: String,
	val state: String,
	val confirmedAt: Double,
	val outOfService: Boolean? = null,
	val startAt: Double? = null,
	val stops: List<RideStop>,
) {
	val id: String get() = "$serviceDate|$tripId"
}

@Serializable
data class Ride(
	val vessel: Vessel,
	val date: String,
	val timezone: String,
	val generatedAt: String,
	val fetchedAt: String? = null,
	val stale: Boolean,
	val positionStale: Boolean,
	val position: RidePosition? = null,
	val nextStop: RideStop? = null,
	val trips: List<RideTrip>,
	val historyNote: String,
)

@Serializable
data class ChangelogEntry(
	val version: String? = null,
	val date: String,
	val title: String,
	val notes: List<String>,
)

@Serializable
data class Changelog(
	val entries: List<ChangelogEntry>,
)
