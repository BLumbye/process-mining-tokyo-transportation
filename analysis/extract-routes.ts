import path from 'node:path'
import {
  XESTrace,
  writeXES,
  loadAndPreprocessStaticData,
} from '../xes-converter'
import { loadLog } from './common'

interface RouteVariation {
  signature: string
  headsign: string
  headsignEnglish: string
  tripIds: Set<string>
  stops: { sequence: number; stopId: string; stopName: string }[]
}

async function getRouteVariations(
  baseFileName: string,
  routeId: string
): Promise<Map<number, RouteVariation>> {
  const staticData = await loadAndPreprocessStaticData(baseFileName)

  // Find all trips for this route
  const tripsForRoute: { tripId: string; headsign: string }[] = []
  for (const [tripId, trip] of staticData.tripsById) {
    if (trip.route_id === routeId) {
      tripsForRoute.push({ tripId, headsign: trip.trip_headsign })
    }
  }

  // Build a map from tripId -> list of stops
  const tripStops = new Map<string, { sequence: number; stopId: string }[]>()
  for (const [key, stopInfo] of staticData.stopTimesByTripAndSequence) {
    const [tripId, sequenceStr] = key.split(':')
    if (!tripStops.has(tripId)) {
      tripStops.set(tripId, [])
    }
    tripStops.get(tripId)!.push({
      sequence: parseInt(sequenceStr, 10),
      stopId: stopInfo.stopId,
    })
  }

  // Build variations with all trip IDs that match each variation
  const variationsBySignature = new Map<string, RouteVariation>()

  for (const { tripId, headsign } of tripsForRoute) {
    const rawStops = tripStops.get(tripId) || []
    const stops = rawStops
      .map((s) => {
        const stop = staticData.stopsById.get(s.stopId)
        const stopName = stop
          ? staticData.translationsByFieldValue.get(stop.stop_name) ||
            stop.stop_name
          : s.stopId
        return { sequence: s.sequence, stopId: s.stopId, stopName }
      })
      .sort((a, b) => a.sequence - b.sequence)

    const signature = stops.map((s) => s.stopId).join('->')

    if (!variationsBySignature.has(signature)) {
      const headsignEnglish =
        staticData.translationsByFieldValue.get(headsign) || headsign
      variationsBySignature.set(signature, {
        signature,
        headsign,
        headsignEnglish,
        tripIds: new Set([tripId]),
        stops,
      })
    } else {
      variationsBySignature.get(signature)!.tripIds.add(tripId)
    }
  }

  // Convert to numbered map
  const variations = new Map<number, RouteVariation>()
  let num = 1
  for (const variation of variationsBySignature.values()) {
    variations.set(num, variation)
    num++
  }

  return variations
}

async function extractRoutes() {
  if (Bun.argv.length < 4) {
    console.log(
      'Needs base file name and route IDs as arguments.\n' +
        'Correct usage: bun run extract-routes.ts <base-file-name> <route-id> [--variations <var1> <var2> ...]\n' +
        'Example: bun run extract-routes.ts ToeiBus 1\n' +
        'Example with variations: bun run extract-routes.ts ToeiTrain 1 --variations 1 2 5'
    )
    process.exit(1)
  }

  const baseFileName = Bun.argv[2]

  // Parse arguments - find --variations flag
  const variationsIndex = Bun.argv.indexOf('--variations')
  let routeIds: Set<string>
  let variationNums: Set<number> | null = null

  if (variationsIndex !== -1) {
    // Route IDs are between argv[3] and --variations
    routeIds = new Set(Bun.argv.slice(3, variationsIndex))
    // Variation numbers are after --variations
    variationNums = new Set(Bun.argv.slice(variationsIndex + 1).map(Number))
  } else {
    routeIds = new Set(Bun.argv.slice(3))
  }

  console.log(`Loading log for ${baseFileName}...`)
  const log = await loadLog(baseFileName)
  console.log(`Loaded ${log.length} traces`)

  let filteredLog: XESTrace[]

  if (variationNums && variationNums.size > 0) {
    // Need to filter by both route and variation
    if (routeIds.size !== 1) {
      console.log(
        'Error: When using --variations, exactly one route ID must be specified'
      )
      process.exit(1)
    }

    const routeId = [...routeIds][0]
    console.log(`Loading route variations for route ${routeId}...`)
    const variations = await getRouteVariations(baseFileName, routeId)

    // Show available variations
    console.log(`\nAvailable variations for route ${routeId}:`)
    for (const [num, variation] of variations) {
      console.log(
        `  ${num}: ${variation.headsignEnglish} (${variation.tripIds.size} trips)`
      )
    }

    // Collect trip IDs from selected variations
    const selectedTripIds = new Set<string>()
    for (const varNum of variationNums) {
      const variation = variations.get(varNum)
      if (!variation) {
        console.log(`Warning: Variation ${varNum} not found, skipping`)
        continue
      }
      for (const tripId of variation.tripIds) {
        selectedTripIds.add(tripId)
      }
    }

    console.log(
      `\nFiltering for route ${routeId}, variations: ${[...variationNums].join(', ')}`
    )
    filteredLog = log.filter(
      (trace) => trace.routeId === routeId && selectedTripIds.has(trace.tripId)
    )
  } else {
    console.log(`Filtering for routes: ${[...routeIds].join(', ')}`)
    filteredLog = log.filter((trace) => routeIds.has(trace.routeId))
  }

  console.log(`Filtered to ${filteredLog.length} traces`)

  if (filteredLog.length === 0) {
    console.log('\nNo traces found for the specified routes/variations.')
    console.log('Available routes in this log:')
    const availableRoutes = new Set(log.map((trace) => trace.routeId))
    console.log([...availableRoutes].sort().join(', '))
    process.exit(1)
  }

  // Generate output filename
  let outputBaseName: string
  if (variationNums && variationNums.size > 0) {
    const routeId = [...routeIds][0]
    const varSuffix = [...variationNums].sort((a, b) => a - b).join('-')
    outputBaseName = `${baseFileName}-route-${routeId}-var-${varSuffix}`
  } else {
    const routeSuffix = [...routeIds].sort().join('-')
    outputBaseName = `${baseFileName}-routes-${routeSuffix}`
  }

  if (!process.env.OUTPUT_DIR) {
    throw new Error('OUTPUT_DIR environment variable is not set')
  }

  const jsonOutputPath = path.join(
    process.env.OUTPUT_DIR,
    `${outputBaseName}.json`
  )
  const xesOutputPath = path.join(
    process.env.OUTPUT_DIR,
    `${outputBaseName}.xes`
  )

  console.log(`Writing JSON to ${jsonOutputPath}...`)
  await Bun.write(jsonOutputPath, JSON.stringify(filteredLog, null, 2))

  console.log(`Writing XES to ${xesOutputPath}...`)
  await writeXES(xesOutputPath, outputBaseName, filteredLog)

  console.log('Done!')
}

extractRoutes()
