import { loadAndPreprocessStaticData } from '../xes-converter'

interface RouteVariation {
  tripId: string
  headsign: string
  headsignEnglish: string
  stops: { sequence: number; stopId: string; stopName: string }[]
}

async function showRouteVariations() {
  if (Bun.argv.length < 4) {
    console.log(
      'Needs base file name and route ID as arguments.\n' +
        'Correct usage: bun run route-variations.ts <base-file-name> <route-id>\n' +
        'Example: bun run route-variations.ts ToeiTrain 1'
    )
    process.exit(1)
  }

  const baseFileName = Bun.argv[2]
  const routeId = Bun.argv[3]

  console.log(`Loading static data for ${baseFileName}...`)
  const staticData = await loadAndPreprocessStaticData(baseFileName)

  // Find all trips for this route
  const tripsForRoute: { tripId: string; headsign: string }[] = []
  for (const [tripId, trip] of staticData.tripsById) {
    if (trip.route_id === routeId) {
      tripsForRoute.push({ tripId, headsign: trip.trip_headsign })
    }
  }

  if (tripsForRoute.length === 0) {
    console.log(`No trips found for route ${routeId}`)
    console.log('Available routes:')
    const availableRoutes = new Set<string>()
    for (const [, trip] of staticData.tripsById) {
      availableRoutes.add(trip.route_id)
    }
    console.log([...availableRoutes].sort().join(', '))
    process.exit(1)
  }

  console.log(`Found ${tripsForRoute.length} trips for route ${routeId}\n`)

  // Build a map from tripId -> list of stops (more efficient than iterating all entries)
  console.log('Building trip stop sequences...')
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

  // Build stop sequence for each trip
  const variations = new Map<string, RouteVariation>()

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

    // Create a signature for this variation (stop IDs in order)
    const signature = stops.map((s) => s.stopId).join('->')

    if (!variations.has(signature)) {
      const headsignEnglish =
        staticData.translationsByFieldValue.get(headsign) || headsign
      variations.set(signature, { tripId, headsign, headsignEnglish, stops })
    }
  }

  console.log(`Found ${variations.size} unique route variations:\n`)
  console.log('='.repeat(80))

  let variationNum = 1
  for (const [signature, variation] of variations) {
    console.log(
      `\nVariation ${variationNum}: ${variation.headsignEnglish} (${variation.headsign})`
    )
    console.log(`Example trip: ${variation.tripId}`)
    console.log(`Stops (${variation.stops.length}):`)

    for (const stop of variation.stops) {
      console.log(
        `  ${stop.sequence.toString().padStart(2)}. [${stop.stopId}] ${stop.stopName}`
      )
    }

    console.log('\n' + '-'.repeat(80))
    variationNum++
  }
}

showRouteVariations()
