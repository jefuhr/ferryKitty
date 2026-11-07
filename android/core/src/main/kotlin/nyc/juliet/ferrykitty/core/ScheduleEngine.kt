package nyc.juliet.ferrykitty.core

import java.text.Collator
import java.time.Instant
import java.time.LocalDate
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max

data class ScheduleFrame(val dateKey: String, val today: String, val seconds: Double, val live: Boolean)

data class ScheduledDeparture(
	val departure: Departure,
	val serviceDate: String,
	val delay: Double,
	val delta: Double,
	val live: Boolean,
	val hasLiveTiming: Boolean,
	val boatName: String? = null,
	val predictedBoatName: String? = null,
	val isLastOfDay: Boolean = false,
	val isLastGovernorsIsland: Boolean = false,
) {
	val id: String get() = "$serviceDate|${departure.tripId}|${departure.stopId}|${departure.seconds}"
	val relativeTime: String get() = when {
		!live -> ""
		delta <= 90 -> "Boarding"
		delta < 3600 -> "${ceil(delta / 60).toInt()} min"
		delta < 86400 -> "${(delta / 3600).toInt()} hr ${ceil(delta % 3600 / 60).toInt()} min"
		else -> "Tomorrow"
	}
}

data class DepartureGroup(
	val id: String,
	val routeId: String,
	val variant: String? = null,
	val directionId: String? = null,
	val destination: String,
	val departures: List<ScheduledDeparture>,
)

data class LayoverTiming(val scheduledSeconds: Double, val estimatedSeconds: Double? = null) {
	val hasLiveTiming: Boolean get() = estimatedSeconds != null
	val seconds: Double get() = estimatedSeconds ?: scheduledSeconds
	val scheduledMinutes: Int get() = floor(scheduledSeconds / 60 + 0.5).toInt()
	val estimatedMinutes: Int? get() = estimatedSeconds?.let { floor(it / 60 + 0.5).toInt() }
	val minutes: Int get() = estimatedMinutes ?: scheduledMinutes
}

data class DeparturePauses(val dwellSeconds: Double? = null, val layover: LayoverTiming? = null) {
	val dwellMinutes: Int? get() = dwellSeconds?.let { floor(it / 60 + 0.5).toInt() }
}

/** Port of iOS FerryCore and the canonical public/assets/schedule.js service-day engine. */
object ScheduleEngine {
	fun frame(data: DisplayData, viewDate: String? = null, now: Instant): ScheduleFrame {
		val parts = ServiceClock.parts(now, data.meta.timezone)
		val live = viewDate == null || viewDate == parts.dateKey
		return ScheduleFrame(if (live) parts.dateKey else requireNotNull(viewDate), parts.dateKey, if (live) parts.seconds else 0.0, live)
	}

	fun activeServices(data: DisplayData, date: String): Set<String> {
		val local = try { LocalDate.parse(date) } catch (_: Exception) { return emptySet() }
		val weekday = local.dayOfWeek.value % 7 // GTFS wire array starts with Sunday.
		val result = data.calendars.filter { date >= it.startDate && date <= it.endDate && it.weekdays.getOrNull(weekday) == true }
			.mapTo(mutableSetOf()) { it.serviceId }
		for (exception in data.exceptions.filter { it.date == date }) {
			if (exception.added) result.add(exception.serviceId) else result.remove(exception.serviceId)
		}
		return result
	}

	fun range(data: DisplayData): ClosedRange<String>? {
		val additions = data.exceptions.filter { it.added }.map { it.date }
		val first = (data.calendars.map { it.startDate } + additions).minOrNull() ?: return null
		val last = (data.calendars.map { it.endDate } + additions).maxOrNull() ?: return null
		return first..last
	}

	fun crewCoverage(data: DisplayData, date: String): CrewCoverage? {
		val status = data.meta.crewScheduleStatus ?: return null
		status.confirmedHolidays?.let { if (date in it.dates) return CrewCoverage(date, date, message = it.message) }
		val local = try { LocalDate.parse(date) } catch (_: Exception) { return null }
		(if (local.dayOfWeek.value in 6..7) status.reviewedWeekends else status.reviewedWeekdays)?.let {
			if (date >= it.startDate && date <= it.endDate && date !in it.excludedDates.orEmpty()) return it
		}
		val coverage = if (local.dayOfWeek.value in 6..7) status.confirmedWeekends else status.confirmedWeekdays
		return coverage?.takeIf { date >= it.startDate && date <= it.endDate && date !in it.excludedDates.orEmpty() }
	}

	fun departurePauses(data: DisplayData, row: ScheduledDeparture, realtime: Realtime): DeparturePauses {
		val departure = row.departure
		if (departure.outOfService == true || departure.crewShuttle == true || !departure.endsShift.isNullOrEmpty()) return DeparturePauses()
		val trip = data.tripSchedules[departure.tripId] ?: departure.liveTripId?.let { data.tripSchedules[it] }
		val call = trip?.stops?.firstOrNull { it.stopId == departure.stopId }
		val dwell = if (data.meta.showDwellTimes == true && call?.arrivalSeconds != null && call.departureSeconds != null)
			(call.departureSeconds - call.arrivalSeconds).takeIf { it.isFinite() && it >= 0 } else null
		val turn = trip?.turnaround
		val scheduled = turn?.scheduledLayoverSeconds
		if (data.meta.showLayoverTimes == false || scheduled == null || !scheduled.isFinite()) return DeparturePauses(dwell)
		val updates = if (row.live && !realtime.stale && !(departure.scheduleOnly == true && departure.liveTripId == null)) realtime.updates.orEmpty() else emptyList()
		val arrivingId = departure.liveTripId ?: trip.liveTripId ?: departure.tripId
		val leavingId = turn.nextLiveTripIdsByDate?.get(row.serviceDate) ?: turn.nextLiveTripId ?:
			turn.nextTripId?.let { data.tripSchedules[it]?.liveTripIdsByDate?.get(row.serviceDate) ?: data.tripSchedules[it]?.liveTripId } ?: turn.nextTripId
		val arriving = updates.firstOrNull { it.tripId == arrivingId && it.stopId == turn.stopId }
		val leaving = updates.firstOrNull { it.tripId == leavingId && it.stopId == turn.stopId }
		fun delay(update: TripUpdate?, arrival: Boolean = false): Double? =
			(if (arrival) update?.arrivalDelaySeconds ?: update?.delaySeconds else update?.delaySeconds)?.takeIf { it.isFinite() }?.let { max(0.0, it) }
		val arrivalDelay = delay(arriving, true)
		val leavingDelay = delay(leaving)
		val live = arriving?.canceled != true && leaving?.canceled != true && (arrivalDelay != null || leavingDelay != null)
		val estimate = if (live) scheduled - (arrivalDelay ?: 0.0) + (leavingDelay ?: 0.0) else null
		if (estimate != null && !estimate.isFinite()) return DeparturePauses(dwell)
		return DeparturePauses(dwell, LayoverTiming(scheduled, estimate))
	}

	fun tripLayover(data: DisplayData, tripId: String, call: TripCall, connectionTurnaround: Turnaround? = null, live: Boolean = false): LayoverTiming? {
		if (data.meta.showLayoverTimes == false) return null
		val trip = data.tripSchedules[tripId]
		val local = if (trip != null && call.sequence == trip.stops.maxOfOrNull { it.sequence } && call.stopId == trip.turnaround?.stopId) trip.turnaround else null
		val turn = connectionTurnaround ?: local ?: return null
		val scheduled = turn.scheduledSeconds ?: turn.scheduledLayoverSeconds ?: return null
		if (!scheduled.isFinite()) return null
		val estimate = turn.estimatedSeconds?.takeIf { live && turn.hasLiveTiming == true && it.isFinite() }
		return LayoverTiming(scheduled, estimate)
	}

	private fun slot(departure: Departure): String = "${departure.routeId}|${departure.variant ?: ""}|${departure.directionId ?: "undefined"}"
	private fun window(data: DisplayData): Double = (if (data.meta.departureWindowMinutes == 0) 180 else data.meta.departureWindowMinutes) * 60.0

	fun groups(data: DisplayData, realtime: Realtime = Realtime.empty, viewDate: String? = null, now: Instant, limitPerGroup: Int? = null): List<DepartureGroup> {
		val frame = frame(data, viewDate, now)
		val updates = mutableMapOf<String, TripUpdate>()
		val vehicles = mutableMapOf<String, VehicleAssignment>()
		val vessels = mutableMapOf<String, VehicleAssignment>()
		if (frame.live) {
			for (update in realtime.updates.orEmpty()) updates["${update.tripId}|${update.stopId}"] = update
			for (vehicle in realtime.vehicles.orEmpty()) {
				vehicles[vehicle.tripId] = vehicle
				val boat = vehicle.boat
				if (boat != null && vehicle.boatName != null && (vehicle.updatedAtEpochSeconds ?: 0.0) >= (vessels[boat]?.updatedAtEpochSeconds ?: 0.0)) vessels[boat] = vehicle
			}
		}
		val grouped = linkedMapOf<String, MutableList<ScheduledDeparture>>()
		val last = mutableMapOf<String, Pair<String, Double>>()
		val islandLast = mutableMapOf<String, Pair<String, Double>>()
		for (offset in -1..0) {
			val serviceDate = ServiceClock.addDays(frame.dateKey, offset)
			val active = activeServices(data, serviceDate)
			for (original in data.departures.filter { it.serviceId in active }) {
				var departure = original.copy(liveTripId = original.liveTripIdsByDate?.get(serviceDate) ?: original.liveTripId,
					predictTripId = original.predictTripIdsByDate?.get(serviceDate) ?: original.predictTripId)
				if (!departure.seconds.isFinite() || ServiceClock.addDays(serviceDate, floor(departure.seconds / 86400).toInt()) != frame.dateKey) continue
				val timetableOnly = departure.scheduleOnly == true && departure.liveTripId == null
				val liveTripId = departure.liveTripId ?: departure.tripId
				val update = if (timetableOnly) null else updates["$liveTripId|${departure.stopId}"]
				if (update?.canceled == true) continue
				val fresh = !realtime.stale && update?.delaySeconds?.isFinite() == true
				val delay = if (fresh) max(0.0, requireNotNull(update.delaySeconds)) else 0.0
				val scheduledMoment = offset * 86400 + departure.seconds
				val delta = scheduledMoment + delay - frame.seconds
				val key = slot(departure)
				val passenger = departure.outOfService != true && departure.crewShuttle != true && departure.arrival != true
				if (passenger && (last[key] == null || scheduledMoment > requireNotNull(last[key]).second)) last[key] = departure.tripId to scheduledMoment
				if (departure.routeId == "SB" && departure.servesGovernorsIsland == true && (islandLast[key] == null || scheduledMoment > requireNotNull(islandLast[key]).second)) islandLast[key] = departure.tripId to scheduledMoment
				if (delta < -60) continue
				val groupKey = "$key|${departure.destination}|${departure.via.orEmpty().joinToString(" > ")}"
				if (data.meta.crewScheduleStatus != null && crewCoverage(data, serviceDate) == null) departure = departure.copy(endsShift = null)
				val boatName = if (timetableOnly) null else vehicles[liveTripId]?.boatName
				val prediction = if (!timetableOnly && boatName == null) departure.predictTripId?.let { vehicles[it]?.boatName }
					?: departure.boatAssignment?.let { vessels["${departure.routeId}$it"]?.boatName } else null
				grouped.getOrPut(groupKey) { mutableListOf() }.add(ScheduledDeparture(departure, serviceDate, delay, delta, frame.live, fresh, boatName, prediction))
			}
		}
		val collator = Collator.getInstance(Locale.US).apply { strength = Collator.SECONDARY }
		val variants = mapOf("A" to 0, "B" to 1, "LOCAL" to 2)
		val comparator = Comparator<DepartureGroup> { left, right ->
			when {
				left.routeId != right.routeId -> collator.compare(left.routeId, right.routeId)
				(variants[left.variant] ?: 3) != (variants[right.variant] ?: 3) -> (variants[left.variant] ?: 3).compareTo(variants[right.variant] ?: 3)
				left.directionId != right.directionId -> (left.directionId ?: "undefined").compareTo(right.directionId ?: "undefined")
				else -> collator.compare(left.destination, right.destination)
			}
		}
		return grouped.mapNotNull { (id, originals) ->
			var rows = originals.sortedBy { it.delta }.map { row -> row.copy(isLastOfDay = last[slot(row.departure)]?.first == row.departure.tripId,
				isLastGovernorsIsland = row.departure.servesGovernorsIsland == true && islandLast[slot(row.departure)]?.first == row.departure.tripId) }
			if (frame.live && rows.first().delta > window(data)) return@mapNotNull null
			if (limitPerGroup != null) rows = rows.take(limitPerGroup.coerceAtLeast(0))
			val first = originals.first().departure
			DepartureGroup(id, first.routeId, first.variant, first.directionId, first.destination, rows)
		}.sortedWith(comparator)
	}

	fun timeline(data: DisplayData, realtime: Realtime = Realtime.empty, viewDate: String? = null, now: Instant): List<ScheduledDeparture> {
		val frame = frame(data, viewDate, now)
		return groups(data, realtime, viewDate, now).flatMap { it.departures }.filter { !frame.live || it.delta <= window(data) }.sortedBy { it.delta }
	}
}
