import BpmnModdle from 'bpmn-moddle'
import { parse } from 'csv-parse/sync'

type ValidBaseFileName = 'ToeiBus' | 'ToeiTrain' | 'TobuTrain'

interface Route {
  route_id: string
  route_short_name: string
  route_long_name: string
}

interface Trip {
  trip_id: string
  route_id: string
  direction_id: string
  shape_id: string
}

interface Stop {
  stop_id: string
  stop_name: string
}

interface StopTime {
  trip_id: string
  stop_id: string
  stop_sequence: string
}

interface Translation {
  table_name: string
  field_name: string
  language: string
  translation: string
  record_id?: string
  field_value?: string
}

interface RouteStopSequence {
  routeId: string
  routeName: string
  directionId: string
  shapeId: string
  stops: { stopId: string; stopName: string; sequence: number }[]
}

async function loadStaticData(baseFileName: ValidBaseFileName) {
  const routesCsv = await Bun.file(`./${baseFileName}-static/routes.txt`).text()
  const tripsCsv = await Bun.file(`./${baseFileName}-static/trips.txt`).text()
  const stopsCsv = await Bun.file(`./${baseFileName}-static/stops.txt`).text()
  const stopTimesCsv = await Bun.file(
    `./${baseFileName}-static/stop_times.txt`
  ).text()
  const translationsCsv = await Bun.file(
    `./${baseFileName}-static/translations.txt`
  ).text()

  const routes = parse(routesCsv, {
    columns: true,
    skip_empty_lines: true,
  }) as Route[]

  const trips = parse(tripsCsv, {
    columns: true,
    skip_empty_lines: true,
  }) as Trip[]

  const stops = parse(stopsCsv, {
    columns: true,
    skip_empty_lines: true,
  }) as Stop[]

  const stopTimes = parse(stopTimesCsv, {
    columns: true,
    skip_empty_lines: true,
  }) as StopTime[]

  const translations = parse(translationsCsv, {
    columns: true,
    skip_empty_lines: true,
  }) as Translation[]

  return { routes, trips, stops, stopTimes, translations }
}

function getEnglishName(
  translations: Translation[],
  baseFileName: ValidBaseFileName,
  japName: string,
  recordId?: string
): string {
  // For bus stops, use record_id for matching
  if (baseFileName === 'ToeiBus' && recordId) {
    const translation = translations.find(
      (t) => t.language === 'en' && t.record_id === recordId
    )
    if (translation) return translation.translation
  }

  // For train stops and routes, use field_value
  const translation = translations.find(
    (t) => t.language === 'en' && t.field_value === japName
  )
  return translation?.translation ?? japName
}

function extractUniqueRouteVariants(
  routes: Route[],
  trips: Trip[],
  stops: Stop[],
  stopTimes: StopTime[],
  translations: Translation[],
  baseFileName: ValidBaseFileName
): RouteStopSequence[] {
  // Build maps for quick lookup
  const stopsById = new Map(stops.map((s) => [s.stop_id, s]))
  const routesById = new Map(routes.map((r) => [r.route_id, r]))

  // Group trips by route_id, direction_id, and shape_id (to get unique route variants)
  const tripsByVariant = new Map<string, Trip>()
  for (const trip of trips) {
    // Use shape_id if available, otherwise use first trip per route+direction
    const variantKey = `${trip.route_id}:${trip.direction_id}:${trip.shape_id || 'default'}`
    if (!tripsByVariant.has(variantKey)) {
      tripsByVariant.set(variantKey, trip)
    }
  }

  // Group stop_times by trip_id for quick lookup
  const stopTimesByTrip = new Map<string, StopTime[]>()
  for (const st of stopTimes) {
    if (!stopTimesByTrip.has(st.trip_id)) {
      stopTimesByTrip.set(st.trip_id, [])
    }
    stopTimesByTrip.get(st.trip_id)!.push(st)
  }

  const routeVariants: RouteStopSequence[] = []

  for (const [variantKey, trip] of tripsByVariant) {
    const route = routesById.get(trip.route_id)
    if (!route) continue

    const tripStopTimes = stopTimesByTrip.get(trip.trip_id)
    if (!tripStopTimes || tripStopTimes.length === 0) continue

    // Sort by stop_sequence
    const sortedStopTimes = [...tripStopTimes].sort(
      (a, b) => parseInt(a.stop_sequence) - parseInt(b.stop_sequence)
    )

    const routeStops = sortedStopTimes.map((st) => {
      const stop = stopsById.get(st.stop_id)
      const japName = stop?.stop_name ?? 'Unknown'
      const englishName = getEnglishName(
        translations,
        baseFileName,
        japName,
        st.stop_id
      )
      return {
        stopId: st.stop_id,
        stopName: englishName,
        sequence: parseInt(st.stop_sequence),
      }
    })

    // Get route name (prefer long name, fall back to short name)
    const japRouteName =
      route.route_long_name || route.route_short_name || route.route_id
    const routeName = getEnglishName(translations, baseFileName, japRouteName)

    routeVariants.push({
      routeId: route.route_id,
      routeName,
      directionId: trip.direction_id,
      shapeId: trip.shape_id || 'default',
      stops: routeStops,
    })
  }

  return routeVariants
}

function sanitizeId(id: string): string {
  // BPMN IDs must be valid NCNames (no special chars at start, limited chars)
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^(\d)/, '_$1')
}

async function generateBpmn(baseFileName: ValidBaseFileName) {
  console.log(`Loading static data for ${baseFileName}...`)
  const { routes, trips, stops, stopTimes, translations } =
    await loadStaticData(baseFileName)

  console.log(`Extracting unique route variants...`)
  const routeVariants = extractUniqueRouteVariants(
    routes,
    trips,
    stops,
    stopTimes,
    translations,
    baseFileName
  )

  console.log(`Found ${routeVariants.length} unique route variants`)

  const moddle = new BpmnModdle()

  // Create the BPMN definitions
  const definitions = moddle.create('bpmn:Definitions', {
    id: `Definitions_${sanitizeId(baseFileName)}`,
    targetNamespace: 'http://bpmn.io/schema/bpmn',
    rootElements: [],
  })

  // Create diagram elements for visual layout
  const bpmnDiagram = moddle.create('bpmndi:BPMNDiagram', {
    id: `BPMNDiagram_${sanitizeId(baseFileName)}`,
    plane: null,
  })

  const plane = moddle.create('bpmndi:BPMNPlane', {
    id: `BPMNPlane_${sanitizeId(baseFileName)}`,
    bpmnElement: null,
    planeElement: [],
  })

  bpmnDiagram.plane = plane

  // Create a collaboration to hold all processes (routes)
  const collaboration = moddle.create('bpmn:Collaboration', {
    id: `Collaboration_${sanitizeId(baseFileName)}`,
    participants: [],
  })

  definitions.rootElements.push(collaboration)
  plane.bpmnElement = collaboration

  let yOffset = 0
  const LANE_HEIGHT = 120
  const ELEMENT_WIDTH = 100
  const ELEMENT_HEIGHT = 80
  const HORIZONTAL_SPACING = 150
  const START_X = 50

  for (const routeVariant of routeVariants) {
    const processId = `Process_${sanitizeId(routeVariant.routeId)}_dir${routeVariant.directionId}_${sanitizeId(routeVariant.shapeId)}`
    const participantId = `Participant_${sanitizeId(routeVariant.routeId)}_dir${routeVariant.directionId}_${sanitizeId(routeVariant.shapeId)}`

    // Create process for this route variant
    const process = moddle.create('bpmn:Process', {
      id: processId,
      name: `${routeVariant.routeName} (Direction ${routeVariant.directionId})`,
      isExecutable: false,
      flowElements: [],
    })

    definitions.rootElements.push(process)

    // Create participant (lane in collaboration)
    const participant = moddle.create('bpmn:Participant', {
      id: participantId,
      name: `${routeVariant.routeName} (Dir ${routeVariant.directionId})`,
      processRef: process,
    })

    collaboration.participants.push(participant)

    // Calculate process width based on number of stops
    const processWidth =
      START_X + (routeVariant.stops.length + 2) * HORIZONTAL_SPACING + 50

    // Add participant shape to diagram
    const participantBounds = moddle.create('dc:Bounds', {
      x: 0,
      y: yOffset,
      width: processWidth,
      height: LANE_HEIGHT,
    })

    const participantShape = moddle.create('bpmndi:BPMNShape', {
      id: `${participantId}_di`,
      bpmnElement: participant,
      bounds: participantBounds,
      isHorizontal: true,
    })

    plane.planeElement.push(participantShape)

    // Create start event
    const startEventId = `StartEvent_${processId}`
    const startEvent = moddle.create('bpmn:StartEvent', {
      id: startEventId,
      name: 'Start',
    })
    process.flowElements.push(startEvent)

    // Add start event shape
    const startBounds = moddle.create('dc:Bounds', {
      x: START_X,
      y: yOffset + (LANE_HEIGHT - 36) / 2,
      width: 36,
      height: 36,
    })

    const startShape = moddle.create('bpmndi:BPMNShape', {
      id: `${startEventId}_di`,
      bpmnElement: startEvent,
      bounds: startBounds,
    })

    plane.planeElement.push(startShape)

    let previousElement: any = startEvent
    let previousX = START_X + 36
    let elementIndex = 0

    // Create task for each stop
    for (const stop of routeVariant.stops) {
      elementIndex++
      const taskId = `Task_${processId}_stop${stop.sequence}`
      const task = moddle.create('bpmn:Task', {
        id: taskId,
        name: stop.stopName,
      })
      process.flowElements.push(task)

      // Add task shape
      const taskX = START_X + elementIndex * HORIZONTAL_SPACING
      const taskBounds = moddle.create('dc:Bounds', {
        x: taskX,
        y: yOffset + (LANE_HEIGHT - ELEMENT_HEIGHT) / 2,
        width: ELEMENT_WIDTH,
        height: ELEMENT_HEIGHT,
      })

      const taskShape = moddle.create('bpmndi:BPMNShape', {
        id: `${taskId}_di`,
        bpmnElement: task,
        bounds: taskBounds,
      })

      plane.planeElement.push(taskShape)

      // Create sequence flow from previous element
      const flowId = `Flow_${processId}_${elementIndex}`
      const flow = moddle.create('bpmn:SequenceFlow', {
        id: flowId,
        sourceRef: previousElement,
        targetRef: task,
      })
      process.flowElements.push(flow)

      // Add flow edge
      const flowEdge = moddle.create('bpmndi:BPMNEdge', {
        id: `${flowId}_di`,
        bpmnElement: flow,
        waypoint: [
          moddle.create('dc:Point', {
            x: previousX,
            y: yOffset + LANE_HEIGHT / 2,
          }),
          moddle.create('dc:Point', {
            x: taskX,
            y: yOffset + LANE_HEIGHT / 2,
          }),
        ],
      })

      plane.planeElement.push(flowEdge)

      previousElement = task
      previousX = taskX + ELEMENT_WIDTH
    }

    // Create end event
    const endEventId = `EndEvent_${processId}`
    const endEvent = moddle.create('bpmn:EndEvent', {
      id: endEventId,
      name: 'End',
    })
    process.flowElements.push(endEvent)

    // Add end event shape
    const endX = START_X + (elementIndex + 1) * HORIZONTAL_SPACING
    const endBounds = moddle.create('dc:Bounds', {
      x: endX,
      y: yOffset + (LANE_HEIGHT - 36) / 2,
      width: 36,
      height: 36,
    })

    const endShape = moddle.create('bpmndi:BPMNShape', {
      id: `${endEventId}_di`,
      bpmnElement: endEvent,
      bounds: endBounds,
    })

    plane.planeElement.push(endShape)

    // Create final sequence flow
    const finalFlowId = `Flow_${processId}_final`
    const finalFlow = moddle.create('bpmn:SequenceFlow', {
      id: finalFlowId,
      sourceRef: previousElement,
      targetRef: endEvent,
    })
    process.flowElements.push(finalFlow)

    // Add final flow edge
    const finalFlowEdge = moddle.create('bpmndi:BPMNEdge', {
      id: `${finalFlowId}_di`,
      bpmnElement: finalFlow,
      waypoint: [
        moddle.create('dc:Point', {
          x: previousX,
          y: yOffset + LANE_HEIGHT / 2,
        }),
        moddle.create('dc:Point', {
          x: endX,
          y: yOffset + LANE_HEIGHT / 2,
        }),
      ],
    })

    plane.planeElement.push(finalFlowEdge)

    yOffset += LANE_HEIGHT + 20
  }

  // Add the diagram to definitions
  definitions.diagrams = [bpmnDiagram]

  // Serialize to XML
  const { xml } = await moddle.toXML(definitions, { format: true })

  // Write to file
  const outputPath = `./output/${baseFileName}.bpmn`
  await Bun.write(outputPath, xml)

  console.log(`BPMN file written to ${outputPath}`)
  console.log(`Total route variants: ${routeVariants.length}`)
}

// Main execution
async function main() {
  if (Bun.argv.length < 3) {
    console.log(
      'Needs base file name as argument (ToeiBus, ToeiTrain, or TobuTrain)'
    )
    console.log('Usage: bun run bpmn/bpmn.ts <base-file-name>')
    process.exit(1)
  }

  const baseFileName = Bun.argv[2]

  if (!['ToeiBus', 'ToeiTrain', 'TobuTrain'].includes(baseFileName)) {
    console.error(
      `Invalid base file name: ${baseFileName}. Must be one of: ToeiBus, ToeiTrain, TobuTrain`
    )
    process.exit(1)
  }

  await generateBpmn(baseFileName as ValidBaseFileName)
}

main().catch(console.error)
