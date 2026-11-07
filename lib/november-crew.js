import {
	boatRuns, serviceBreaks, calendarTurnaroundLayovers, homePortRows, homePortDepartures
} from './out-of-service.js';
const PREFIX = 'nyc:november:';
const seconds = time => time.split(':').reduce((value,part)=>value*60+Number(part),0)*60;

// Operational rows are derived only from exact Board/GTFS boundaries. A feed's last
// trip alone does not verify a crew return, and a missing note never creates one.
export function novemberCrewOperations({source, trips, timesByTrip, calendars, exceptions,
	stopName, selectedStops, isVirtual, homePort, operator}) {
	const empty = {breaks:{certainty:new Map(),endAt:new Map(),tieUps:[]},turnarounds:new Map(),rows:[],schedules:{}};
	if (!source) return empty;
	const kind = source.kind || 'weekday';
	const assigned = trips.filter(t=>t.trip_id.startsWith(PREFIX)&&source.assignments[t.trip_id.slice(PREFIX.length)]!=null)
		.map(t=>({...t,trip_short_name:t.trip_id,service_id:source.operationServiceByTrip?.[t.trip_id.slice(PREFIX.length)]
			? PREFIX+source.operationServiceByTrip[t.trip_id.slice(PREFIX.length)] : t.service_id}));
	const assignments=Object.fromEntries(assigned.map(t=>[t.trip_id,source.assignments[t.trip_id.slice(PREFIX.length)]]));
	const runs=boatRuns({trips:assigned,timesByTrip,boatAssignments:assignments});
	const shifts={[kind]:{}};
	for(const record of source.shifts){
		const entry={shift:record.shift,source:record.source,serviceIds:(record.serviceIds || source.serviceIds).map(id=>PREFIX+id)};
		for(const key of ['start','end']) if(record[key]) {
			entry[key+'Time']=record[key].time;
			entry[key+'Place']=stopName(record[key].stopId);
		}
		if(record.shift==='PM'&&source.reliefBoats.includes(record.boat)) entry.shuttled=true;
		(shifts[kind][record.boat]??=[]).push(entry);
	}
	for(const list of Object.values(shifts[kind]))list.sort((a,b)=>(a.startTime??'99').localeCompare(b.startTime??'99'));
	const complete={[kind]:Object.fromEntries(Object.entries(shifts[kind])
		.map(([boat,list])=>[boat,list.filter(r=>r.startTime&&r.endTime)]))};
	const dayTypeOf=()=> kind;
	const breaks=serviceBreaks({runs,dayTypeOf,shifts:complete,timesByTrip,stopName});
	const verifiedEnd=run=>source.shifts.some(r=>r.boat===`${run.routeId}${run.boat}`&&r.end
		&&PREFIX+r.end.tripId===run.tripId&&r.end.stopId===run.endStopId&&seconds(r.end.time)===run.endSeconds);
	breaks.tieUps=breaks.tieUps.filter(verifiedEnd);
	const endTrips=new Set(breaks.tieUps.map(run=>run.tripId));
	for(const id of breaks.certainty.keys()) if(!endTrips.has(id))breaks.certainty.delete(id);
	for(const id of breaks.endAt.keys())if(!endTrips.has(id))breaks.endAt.delete(id);
	const terminalEnds=new Map(breaks.certainty);
	for(const [id,cutoff] of breaks.endAt){
		const final=timesByTrip.get(id)?.at(-1);
		if(final && cutoff<final.arrival_time.split(':').reduce((v,p)=>v*60+Number(p),0)) terminalEnds.delete(id);
	}
	const turnarounds=calendarTurnaroundLayovers({runs,endsShift:terminalEnds,calendars,exceptions});
	const rows=homePortRows({tieUps:breaks.tieUps,selectedStops,homePort,operator});
	if(isVirtual) rows.push(...homePortDepartures({shifts,dayTypeOf,servicesOfDay:()=>PREFIX+(source.operationServiceIds || source.serviceIds)[0],homePort,operator,runs}));
	const schedules={};
	for(const row of rows){
		const original=row.liveTripId||row.predictTripId;
		const calls=timesByTrip.get(original);
		if(calls) schedules['november:crew:'+row.tripId]={liveTripId:original.slice(PREFIX.length),
			stops:calls.map(c=>({stopId:c.stop_id,sequence:Number(c.stop_sequence),
				arrivalSeconds:c.arrival_time.split(':').reduce((v,p)=>v*60+Number(p),0),
				departureSeconds:c.departure_time.split(':').reduce((v,p)=>v*60+Number(p),0)}))};
		row.tripId='november:crew:'+row.tripId;
		if(row.liveTripId)row.liveTripId=row.liveTripId.slice(PREFIX.length);
		if(row.predictTripId)row.predictTripId=row.predictTripId.slice(PREFIX.length);
	}
	return {breaks,turnarounds,rows,schedules};
}
