import readline from 'readline'
import { readdir, writeFile } from 'node:fs/promises'
import { OutputFile } from './output-file-types'
import { create } from 'xmlbuilder2'
import path from 'node:path'
import { createReadStream } from 'node:fs'
import { parse } from 'csv-parse/sync'

interface XESTrace {
  id: string
  tripId: string
  routeId: string
  lineName: string
  events: XESEvent[]
}

interface XESEvent {
  stopSequence: number
  stopId: string
  stopName: string
  // beforeTimestamp: string
  afterTimestamp: string
  // latitude: number;
  // longitude: number;
}

// const baseFileTypes = ['TobuTrain', 'ToeiBus', 'ToeiTrain']
const baseFileTypes = ['ToeiBus']

interface StaticData {
  trips: Record<string, string>[]
  routes: Record<string, string>[]
  stops: Record<string, string>[]
  stopTimes: Record<string, string>[]
  translations: Record<string, string>[]
}

interface OptimizedStaticData {
  // Map from trip_id to trip record
  tripsById: Map<string, Record<string, string>>
  // Map from route_id to route record
  routesById: Map<string, Record<string, string>>
  // Map from stop_id to stop record
  stopsById: Map<string, Record<string, string>>
  // Map from "trip_id:stop_sequence" to stop_id
  stopTimesByTripAndSequence: Map<string, string>
  // For Bus: Map from record_id (stop_id) to English translation
  // For Train: Map from field_value (stop/route name) to English translation
  translationsByRecordId: Map<string, string>
  translationsByFieldValue: Map<string, string>
}

for (const baseFileType of baseFileTypes) {
  convertXES(baseFileType)
}

function preprocessStaticData(staticData: StaticData): OptimizedStaticData {
  // Build trips map
  const tripsById = new Map<string, Record<string, string>>()
  for (const trip of staticData.trips) {
    tripsById.set(trip.trip_id, trip)
  }

  // Build routes map
  const routesById = new Map<string, Record<string, string>>()
  for (const route of staticData.routes) {
    routesById.set(route.route_id, route)
  }

  // Build stops map
  const stopsById = new Map<string, Record<string, string>>()
  for (const stop of staticData.stops) {
    stopsById.set(stop.stop_id, stop)
  }

  // Build stop times map (composite key: "trip_id:stop_sequence" -> stop_id)
  const stopTimesByTripAndSequence = new Map<string, string>()
  for (const stopTime of staticData.stopTimes) {
    const key = `${stopTime.trip_id}:${stopTime.stop_sequence}`
    stopTimesByTripAndSequence.set(key, stopTime.stop_id)
  }

  // Build translation maps
  const translationsByRecordId = new Map<string, string>()
  const translationsByFieldValue = new Map<string, string>()
  for (const translation of staticData.translations) {
    if (translation.language === 'en') {
      if (translation.record_id) {
        translationsByRecordId.set(
          translation.record_id,
          translation.translation
        )
      }
      if (translation.field_value) {
        translationsByFieldValue.set(
          translation.field_value,
          translation.translation
        )
      }
    }
  }

  return {
    tripsById,
    routesById,
    stopsById,
    stopTimesByTripAndSequence,
    translationsByRecordId,
    translationsByFieldValue,
  }
}

function lookupEventStaticData(
  staticData: OptimizedStaticData,
  baseFileName: string,
  tripId: string,
  stopSequence: number
): { stopId: string; stopName: string } {
  const key = `${tripId}:${stopSequence}`
  const lookupStopId = staticData.stopTimesByTripAndSequence.get(key)

  if (lookupStopId == undefined) {
    throw Error(
      `Stop id not found for trip_id ${tripId} and stop_sequence ${stopSequence}`
    )
  }

  const lookupStop = staticData.stopsById.get(lookupStopId)

  if (lookupStop == undefined) {
    throw Error(`Stop not found for stop_id: ${lookupStopId}`)
  }

  const lookupStopName = lookupStop.stop_name

  let lookupStopEnglishName: string | undefined

  if (baseFileName.includes('Bus')) {
    lookupStopEnglishName = staticData.translationsByRecordId.get(lookupStopId)

    if (lookupStopEnglishName == undefined) {
      throw Error(
        `Missing English translation for stop name ${lookupStopName}. Stop id: ${lookupStopId}`
      )
    }
  } else {
    lookupStopEnglishName =
      staticData.translationsByFieldValue.get(lookupStopName)

    if (lookupStopEnglishName == undefined) {
      throw Error(
        `Missing English translation for stop name ${lookupStopName}. Stop id: ${lookupStopId}`
      )
    }
  }

  return {
    stopId: lookupStopId,
    stopName: lookupStopEnglishName,
  }
}

function lookupTraceStaticData(
  staticData: OptimizedStaticData,
  baseFileName: string,
  tripId: string,
  routeId: string
): { routeId: string; lineName: string } {
  const lookupTrip = staticData.tripsById.get(tripId)

  if (lookupTrip == undefined) {
    throw Error(`Trip not found for trip_id: ${tripId}`)
  }

  // routeId is given on some files (double check they are the same if given)
  if (routeId !== '' && routeId !== lookupTrip.route_id) {
    throw Error("lookup route id doesn't match route id in source json")
  }

  const lookupRoute = staticData.routesById.get(lookupTrip.route_id)

  if (lookupRoute == undefined) {
    throw Error(`Route not found for route_id: ${lookupTrip.route_id}`)
  }

  const lookupLongRouteName = lookupRoute.route_long_name

  let lookupLongRouteEnglishName: string | undefined
  if (baseFileName.includes('Bus')) {
    lookupLongRouteEnglishName = staticData.translationsByFieldValue.get(
      lookupTrip.trip_headsign
    )

    if (lookupLongRouteEnglishName == undefined) {
      throw Error(
        `Missing English translation for route name ${lookupLongRouteName}`
      )
    }
  } else {
    lookupLongRouteEnglishName =
      staticData.translationsByFieldValue.get(lookupLongRouteName)

    if (lookupLongRouteEnglishName == undefined) {
      throw Error(
        `Missing English translation for route name ${lookupLongRouteName}`
      )
    }
  }

  return {
    routeId: lookupTrip.route_id,
    lineName: lookupLongRouteEnglishName,
  }
}

async function convertXES(baseFileName: string): Promise<void> {
  console.log(`Starting ${baseFileName}`)

  if (!process.env.OUTPUT_DIR) {
    throw Error('OUTPUT_DIR environment variable is not set')
  }

  // Find all files in output
  const allFiles = await readdir(process.env.OUTPUT_DIR)
  const filteredFiles = allFiles.filter((file) =>
    file.includes(`${baseFileName}.jsonl`)
  )

  const traces = new Map<string, XESTrace>()
  const previousStates = new Map<string, { stop: number; timestamp: string }>()

  // Load static files
  const tripsCsv = await Bun.file(`./${baseFileName}-static/trips.txt`).text()
  const routesCsv = await Bun.file(`./${baseFileName}-static/routes.txt`).text()
  const stopsCsv = await Bun.file(`./${baseFileName}-static/stops.txt`).text()
  const stopTimesCsv = await Bun.file(
    `./${baseFileName}-static/stop_times.txt`
  ).text()
  const translationsCsv = await Bun.file(
    `./${baseFileName}-static/translations.txt`
  ).text()

  const trips = parse(tripsCsv, {
    columns: true,
    skip_empty_lines: true,
  }) as Record<string, string>[]
  const routes = parse(routesCsv, {
    columns: true,
    skip_empty_lines: true,
  }) as Record<string, string>[]
  const translations = parse(translationsCsv, {
    columns: true,
    skip_empty_lines: true,
  }) as Record<string, string>[]
  const stops = parse(stopsCsv, {
    columns: true,
    skip_empty_lines: true,
  }) as Record<string, string>[]
  const stopTimes = parse(stopTimesCsv, {
    columns: true,
    skip_empty_lines: true,
  }) as Record<string, string>[]

  const staticData: StaticData = {
    trips,
    routes,
    stops,
    stopTimes,
    translations,
  }

  console.log('Preprocessing static data into maps for fast lookup...')
  const optimizedStaticData = preprocessStaticData(staticData)
  console.log('Static data preprocessing complete')

  // Go through files
  for (let fileName of filteredFiles) {
    console.log(`Processing ${fileName}`)

    const rl = readline.createInterface({
      input: createReadStream(path.join(process.env.OUTPUT_DIR, fileName)),
      crlfDelay: Infinity,
    })

    //setup data structure for XML/XES format
    let lineNo = 1
    for await (const line of rl) {
      console.log(`Processing line ${lineNo} of ${fileName}`)
      lineNo++
      const lineJson = JSON.parse(line) as OutputFile
      for (const entity of lineJson.entity) {
        if (entity.vehicle.trip.tripId === '') continue

        const nextState = {
          stop: entity.vehicle.currentStopSequence,
          timestamp: entity.vehicle.timestamp,
        }

        if (previousStates.has(entity.id)) {
          const previousState = previousStates.get(entity.id)!

          if (previousState.stop !== nextState.stop) {
            try {
              const eventStaticData = lookupEventStaticData(
                optimizedStaticData,
                baseFileName,
                entity.vehicle.trip.tripId,
                nextState.stop
              )

              if (eventStaticData == null) {
                continue
              }

              const event: XESEvent = {
                stopSequence: nextState.stop,
                stopId: eventStaticData.stopId,
                stopName: eventStaticData.stopName,
                afterTimestamp: nextState.timestamp,
                // latitude: entity.vehicle.position.latitude,
                // longitude: entity.vehicle.position.longitude,
              }

              if (traces.has(entity.id)) {
                const trace = traces.get(entity.id)!
                trace.events.push(event)
              } else {
                // traceId is not empty string (but routeIdcan be)
                const tripId = entity.vehicle.trip.tripId
                const routeId = entity.vehicle.trip.routeId

                const traceStaticData = lookupTraceStaticData(
                  optimizedStaticData,
                  baseFileName,
                  tripId,
                  routeId
                )

                traces.set(entity.id, {
                  id: entity.id,
                  tripId: tripId,
                  routeId: traceStaticData.routeId,
                  lineName: traceStaticData.lineName,
                  events: [event],
                })
              }
            } catch (err) {
              console.error(err)
              continue
            }
          }
        }

        previousStates.set(entity.id, nextState)
      }
    }
  }

  // Convert to XES format
  const xes = create({ version: '1.0', encoding: 'UTF-8' })
    .ele('log', {
      'xes.version': '1.0',
      'xes.features': 'nested-attributes',
      'openxes.version': '1.0RC7',
      xmlns: 'http://www.xes-standard.org/',
    })
    .ele('extension', {
      name: 'Time',
      prefix: 'time',
      uri: 'http://www.xes-standard.org/time.xesext',
    })
    .up()
    .ele('extension', {
      name: 'Concept',
      prefix: 'concept',
      uri: 'http://www.xes-standard.org/concept.xesext',
    })
    .up()
    .ele('string', {
      key: 'concept:name',
      value: baseFileName,
    })
    .up()

  // Add traces
  for (const trace of traces.values()) {
    const traceElement = xes
      .ele('trace')
      .ele('string', { key: 'concept:name', value: trace.id })
      .ele('string', { key: 'tripId', value: trace.tripId })
      .ele('string', { key: 'routeId', value: trace.routeId })
      .ele('string', { key: 'lineName', value: trace.lineName })
      .up()

    // Add events
    for (const event of trace.events) {
      const eventElement = traceElement.ele('event')
      eventElement.ele('string', {
        key: 'concept:name',
        value: 'currentStopSequenceChanged',
      })
      eventElement.ele('date', {
        key: 'time:timestamp',
        value: new Date(Number(event.afterTimestamp) * 1000).toISOString(),
      })
      eventElement.ele('int', {
        key: 'stopSequence',
        values: event.stopSequence,
      })
      eventElement.ele('string', {
        key: 'stopId',
        value: event.stopId,
      })
      eventElement.ele('string', {
        key: 'stopName',
        value: event.stopName,
      })
    }
  }

  const outputFile = path.join(process.env.OUTPUT_DIR, `${baseFileName}.xes`)
  writeFile(outputFile, xes.end({ prettyPrint: true }), 'utf-8')
  console.log(`Finished ${baseFileName}, output to ${outputFile}`)
}
