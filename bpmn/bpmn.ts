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

  // Group stop_times by trip_id for quick lookup
  const stopTimesByTrip = new Map<string, StopTime[]>()
  for (const st of stopTimes) {
    if (!stopTimesByTrip.has(st.trip_id)) {
      stopTimesByTrip.set(st.trip_id, [])
    }
    stopTimesByTrip.get(st.trip_id)!.push(st)
  }

  // Build unique route variants based on actual stop sequences
  // Key: stop sequence signature (stop_ids joined), Value: first trip with this sequence
  const uniqueSequences = new Map<string, { trip: Trip; stopIds: string[] }>()

  for (const trip of trips) {
    const tripStopTimes = stopTimesByTrip.get(trip.trip_id)
    if (!tripStopTimes || tripStopTimes.length === 0) continue

    // Sort by stop_sequence
    const sortedStopTimes = [...tripStopTimes].sort(
      (a, b) => parseInt(a.stop_sequence) - parseInt(b.stop_sequence)
    )

    // Create a signature based on the actual stop sequence
    const stopIds = sortedStopTimes.map((st) => st.stop_id)
    const sequenceSignature = stopIds.join('|')

    if (!uniqueSequences.has(sequenceSignature)) {
      uniqueSequences.set(sequenceSignature, { trip, stopIds })
    }
  }

  const routeVariants: RouteStopSequence[] = []

  for (const [sequenceSignature, { trip, stopIds }] of uniqueSequences) {
    const route = routesById.get(trip.route_id)
    if (!route) continue

    const tripStopTimes = stopTimesByTrip.get(trip.trip_id)!
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

interface StopNode {
  stopId: string
  stopName: string
  x: number
  y: number
  incomingRoutes: Set<string> // route variant keys that lead TO this stop
  outgoingRoutes: Set<string> // route variant keys that lead FROM this stop
  hasSelfLoop: boolean // whether this stop has a self-loop (same stop appears consecutively)
}

interface RouteEdge {
  fromStopId: string | 'START_GATEWAY'
  toStopId: string | 'END_GATEWAY'
  routeVariantKey: string
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

  // Build a graph of unique stops and edges between them
  const uniqueStops = new Map<string, StopNode>()
  const edges: RouteEdge[] = []

  // Collect all unique stops and build edges
  for (const routeVariant of routeVariants) {
    const routeKey = `${routeVariant.routeId}_dir${routeVariant.directionId}_${routeVariant.shapeId}`

    for (let i = 0; i < routeVariant.stops.length; i++) {
      const stop = routeVariant.stops[i]

      // Use stopName as key for merging (stops with same name become one node)
      if (!uniqueStops.has(stop.stopName)) {
        uniqueStops.set(stop.stopName, {
          stopId: stop.stopId,
          stopName: stop.stopName,
          x: 0,
          y: 0,
          incomingRoutes: new Set(),
          outgoingRoutes: new Set(),
          hasSelfLoop: false,
        })
      }

      const stopNode = uniqueStops.get(stop.stopName)!

      // First stop - edge from start gateway
      if (i === 0) {
        edges.push({
          fromStopId: 'START_GATEWAY',
          toStopId: stop.stopName,
          routeVariantKey: routeKey,
        })
        stopNode.incomingRoutes.add(routeKey)
      }

      // Edge to next stop
      if (i < routeVariant.stops.length - 1) {
        const nextStop = routeVariant.stops[i + 1]
        // Check for self-loop (same stop name appears consecutively)
        if (stop.stopName === nextStop.stopName) {
          // Mark this stop as having a self-loop instead of creating an edge
          stopNode.hasSelfLoop = true
        } else {
          edges.push({
            fromStopId: stop.stopName,
            toStopId: nextStop.stopName,
            routeVariantKey: routeKey,
          })
          stopNode.outgoingRoutes.add(routeKey)
        }
      }

      // Last stop - edge to end gateway
      if (i === routeVariant.stops.length - 1) {
        edges.push({
          fromStopId: stop.stopName,
          toStopId: 'END_GATEWAY',
          routeVariantKey: routeKey,
        })
        stopNode.outgoingRoutes.add(routeKey)
      }
    }
  }

  console.log(`Merged into ${uniqueStops.size} unique stops`)

  // Count stops with self-loops
  const selfLoopCount = Array.from(uniqueStops.values()).filter(
    (s) => s.hasSelfLoop
  ).length
  console.log(`Found ${selfLoopCount} stops with self-loops`)

  // Deduplicate edges (same from -> to might appear in multiple routes)
  const uniqueEdges = new Map<string, RouteEdge>()
  for (const edge of edges) {
    const edgeKey = `${edge.fromStopId}:${edge.toStopId}`
    if (!uniqueEdges.has(edgeKey)) {
      uniqueEdges.set(edgeKey, edge)
    }
  }

  console.log(`Created ${uniqueEdges.size} unique edges`)

  // Count incoming and outgoing edges for each stop
  const incomingEdgeCount = new Map<string, number>()
  const outgoingEdgeCount = new Map<string, number>()

  for (const [, edge] of uniqueEdges) {
    if (edge.toStopId !== 'END_GATEWAY') {
      incomingEdgeCount.set(
        edge.toStopId,
        (incomingEdgeCount.get(edge.toStopId) || 0) + 1
      )
    }
    if (edge.fromStopId !== 'START_GATEWAY') {
      outgoingEdgeCount.set(
        edge.fromStopId,
        (outgoingEdgeCount.get(edge.fromStopId) || 0) + 1
      )
    }
  }

  // Identify stops that need gateways
  const stopsNeedingSplitGateway = new Set<string>()
  const stopsNeedingMergeGateway = new Set<string>()

  for (const [stopName] of uniqueStops) {
    if ((outgoingEdgeCount.get(stopName) || 0) > 1) {
      stopsNeedingSplitGateway.add(stopName)
    }
    if ((incomingEdgeCount.get(stopName) || 0) > 1) {
      stopsNeedingMergeGateway.add(stopName)
    }
  }

  console.log(`Stops needing split gateway: ${stopsNeedingSplitGateway.size}`)
  console.log(`Stops needing merge gateway: ${stopsNeedingMergeGateway.size}`)

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

  // Create a single process
  const process = moddle.create('bpmn:Process', {
    id: `Process_${sanitizeId(baseFileName)}`,
    name: `${baseFileName} Transportation Network`,
    isExecutable: false,
    flowElements: [],
  })

  definitions.rootElements.push(process)
  plane.bpmnElement = process

  // Layout constants
  const ELEMENT_WIDTH = 100
  const ELEMENT_HEIGHT = 80
  const GATEWAY_SIZE = 50
  const HORIZONTAL_SPACING = 180
  const VERTICAL_SPACING = 100
  const START_X = 50
  const START_Y = 50

  // Calculate grid layout for stops
  const stopsArray = Array.from(uniqueStops.values())
  const gridCols = Math.ceil(Math.sqrt(stopsArray.length))

  // Assign positions to stops in a grid
  stopsArray.forEach((stop, index) => {
    const col = index % gridCols
    const row = Math.floor(index / gridCols)
    stop.x = START_X + HORIZONTAL_SPACING + col * HORIZONTAL_SPACING
    stop.y = START_Y + GATEWAY_SIZE + 50 + row * VERTICAL_SPACING
  })

  // Find bounds for gateway positioning
  const maxX = Math.max(...stopsArray.map((s) => s.x)) + ELEMENT_WIDTH
  const maxY = Math.max(...stopsArray.map((s) => s.y)) + ELEMENT_HEIGHT
  const centerY = (START_Y + maxY) / 2

  // Map to store BPMN elements by their key
  const bpmnElements = new Map<string, any>()

  // Track all sequence flows to add incoming/outgoing references later
  const allFlows: { flow: any; sourceElement: any; targetElement: any }[] = []

  // Create start event
  const startEvent = moddle.create('bpmn:StartEvent', {
    id: 'StartEvent_1',
    name: 'Start',
    outgoing: [],
  })
  process.flowElements.push(startEvent)
  bpmnElements.set('START', startEvent)

  const startBounds = moddle.create('dc:Bounds', {
    x: START_X - 100,
    y: centerY - 18,
    width: 36,
    height: 36,
  })
  plane.planeElement.push(
    moddle.create('bpmndi:BPMNShape', {
      id: 'StartEvent_1_di',
      bpmnElement: startEvent,
      bounds: startBounds,
    })
  )

  // Create start gateway (exclusive, splitting)
  const startGateway = moddle.create('bpmn:ExclusiveGateway', {
    id: 'Gateway_Start',
    name: 'Select Route',
    incoming: [],
    outgoing: [],
  })
  process.flowElements.push(startGateway)
  bpmnElements.set('START_GATEWAY', startGateway)

  const startGatewayBounds = moddle.create('dc:Bounds', {
    x: START_X - 25,
    y: centerY - GATEWAY_SIZE / 2,
    width: GATEWAY_SIZE,
    height: GATEWAY_SIZE,
  })
  plane.planeElement.push(
    moddle.create('bpmndi:BPMNShape', {
      id: 'Gateway_Start_di',
      bpmnElement: startGateway,
      bounds: startGatewayBounds,
      isMarkerVisible: true,
    })
  )

  // Create flow from start event to start gateway
  const startToGatewayFlow = moddle.create('bpmn:SequenceFlow', {
    id: 'Flow_Start_to_Gateway',
    sourceRef: startEvent,
    targetRef: startGateway,
  })
  process.flowElements.push(startToGatewayFlow)
  allFlows.push({
    flow: startToGatewayFlow,
    sourceElement: startEvent,
    targetElement: startGateway,
  })
  plane.planeElement.push(
    moddle.create('bpmndi:BPMNEdge', {
      id: 'Flow_Start_to_Gateway_di',
      bpmnElement: startToGatewayFlow,
      waypoint: [
        moddle.create('dc:Point', { x: START_X - 64, y: centerY }),
        moddle.create('dc:Point', { x: START_X - 25, y: centerY }),
      ],
    })
  )

  // Create end gateway (exclusive, merging)
  const endGateway = moddle.create('bpmn:ExclusiveGateway', {
    id: 'Gateway_End',
    name: 'Routes Complete',
    incoming: [],
    outgoing: [],
  })
  process.flowElements.push(endGateway)
  bpmnElements.set('END_GATEWAY', endGateway)

  const endGatewayBounds = moddle.create('dc:Bounds', {
    x: maxX + HORIZONTAL_SPACING,
    y: centerY - GATEWAY_SIZE / 2,
    width: GATEWAY_SIZE,
    height: GATEWAY_SIZE,
  })
  plane.planeElement.push(
    moddle.create('bpmndi:BPMNShape', {
      id: 'Gateway_End_di',
      bpmnElement: endGateway,
      bounds: endGatewayBounds,
      isMarkerVisible: true,
    })
  )

  // Create end event
  const endEvent = moddle.create('bpmn:EndEvent', {
    id: 'EndEvent_1',
    name: 'End',
    incoming: [],
  })
  process.flowElements.push(endEvent)
  bpmnElements.set('END', endEvent)

  const endBounds = moddle.create('dc:Bounds', {
    x: maxX + HORIZONTAL_SPACING + GATEWAY_SIZE + 50,
    y: centerY - 18,
    width: 36,
    height: 36,
  })
  plane.planeElement.push(
    moddle.create('bpmndi:BPMNShape', {
      id: 'EndEvent_1_di',
      bpmnElement: endEvent,
      bounds: endBounds,
    })
  )

  // Create flow from end gateway to end event
  const gatewayToEndFlow = moddle.create('bpmn:SequenceFlow', {
    id: 'Flow_Gateway_to_End',
    sourceRef: endGateway,
    targetRef: endEvent,
  })
  process.flowElements.push(gatewayToEndFlow)
  allFlows.push({
    flow: gatewayToEndFlow,
    sourceElement: endGateway,
    targetElement: endEvent,
  })
  plane.planeElement.push(
    moddle.create('bpmndi:BPMNEdge', {
      id: 'Flow_Gateway_to_End_di',
      bpmnElement: gatewayToEndFlow,
      waypoint: [
        moddle.create('dc:Point', {
          x: maxX + HORIZONTAL_SPACING + GATEWAY_SIZE,
          y: centerY,
        }),
        moddle.create('dc:Point', {
          x: maxX + HORIZONTAL_SPACING + GATEWAY_SIZE + 50,
          y: centerY,
        }),
      ],
    })
  )

  // Create tasks for each unique stop (and associated gateways if needed)
  for (const [stopName, stop] of uniqueStops) {
    const taskId = `Task_${sanitizeId(stopName)}`

    // If stop has a self-loop, add a standard loop characteristic
    let loopCharacteristics = undefined
    if (stop.hasSelfLoop) {
      loopCharacteristics = moddle.create('bpmn:StandardLoopCharacteristics', {
        id: `Loop_${sanitizeId(stopName)}`,
      })
    }

    const task = moddle.create('bpmn:Task', {
      id: taskId,
      name: stopName,
      loopCharacteristics: loopCharacteristics,
      incoming: [],
      outgoing: [],
    })
    process.flowElements.push(task)
    bpmnElements.set(stopName, task)

    const taskBounds = moddle.create('dc:Bounds', {
      x: stop.x,
      y: stop.y,
      width: ELEMENT_WIDTH,
      height: ELEMENT_HEIGHT,
    })
    plane.planeElement.push(
      moddle.create('bpmndi:BPMNShape', {
        id: `${taskId}_di`,
        bpmnElement: task,
        bounds: taskBounds,
      })
    )

    // Create merge gateway before task if needed (for multiple incoming edges)
    if (stopsNeedingMergeGateway.has(stopName)) {
      const mergeGatewayId = `Gateway_Merge_${sanitizeId(stopName)}`
      const mergeGateway = moddle.create('bpmn:ExclusiveGateway', {
        id: mergeGatewayId,
        incoming: [],
        outgoing: [],
      })
      process.flowElements.push(mergeGateway)
      bpmnElements.set(`MERGE_${stopName}`, mergeGateway)

      // Position merge gateway to the left of the task
      const mergeGatewayBounds = moddle.create('dc:Bounds', {
        x: stop.x - GATEWAY_SIZE - 20,
        y: stop.y + (ELEMENT_HEIGHT - GATEWAY_SIZE) / 2,
        width: GATEWAY_SIZE,
        height: GATEWAY_SIZE,
      })
      plane.planeElement.push(
        moddle.create('bpmndi:BPMNShape', {
          id: `${mergeGatewayId}_di`,
          bpmnElement: mergeGateway,
          bounds: mergeGatewayBounds,
          isMarkerVisible: true,
        })
      )

      // Create flow from merge gateway to task
      const mergeToTaskFlowId = `Flow_Merge_to_${sanitizeId(stopName)}`
      const mergeToTaskFlow = moddle.create('bpmn:SequenceFlow', {
        id: mergeToTaskFlowId,
        sourceRef: mergeGateway,
        targetRef: task,
      })
      process.flowElements.push(mergeToTaskFlow)
      allFlows.push({
        flow: mergeToTaskFlow,
        sourceElement: mergeGateway,
        targetElement: task,
      })
      plane.planeElement.push(
        moddle.create('bpmndi:BPMNEdge', {
          id: `${mergeToTaskFlowId}_di`,
          bpmnElement: mergeToTaskFlow,
          waypoint: [
            moddle.create('dc:Point', {
              x: stop.x - 20,
              y: stop.y + ELEMENT_HEIGHT / 2,
            }),
            moddle.create('dc:Point', {
              x: stop.x,
              y: stop.y + ELEMENT_HEIGHT / 2,
            }),
          ],
        })
      )
    }

    // Create split gateway after task if needed (for multiple outgoing edges)
    if (stopsNeedingSplitGateway.has(stopName)) {
      const splitGatewayId = `Gateway_Split_${sanitizeId(stopName)}`
      const splitGateway = moddle.create('bpmn:ExclusiveGateway', {
        id: splitGatewayId,
        incoming: [],
        outgoing: [],
      })
      process.flowElements.push(splitGateway)
      bpmnElements.set(`SPLIT_${stopName}`, splitGateway)

      // Position split gateway to the right of the task
      const splitGatewayBounds = moddle.create('dc:Bounds', {
        x: stop.x + ELEMENT_WIDTH + 20,
        y: stop.y + (ELEMENT_HEIGHT - GATEWAY_SIZE) / 2,
        width: GATEWAY_SIZE,
        height: GATEWAY_SIZE,
      })
      plane.planeElement.push(
        moddle.create('bpmndi:BPMNShape', {
          id: `${splitGatewayId}_di`,
          bpmnElement: splitGateway,
          bounds: splitGatewayBounds,
          isMarkerVisible: true,
        })
      )

      // Create flow from task to split gateway
      const taskToSplitFlowId = `Flow_${sanitizeId(stopName)}_to_Split`
      const taskToSplitFlow = moddle.create('bpmn:SequenceFlow', {
        id: taskToSplitFlowId,
        sourceRef: task,
        targetRef: splitGateway,
      })
      process.flowElements.push(taskToSplitFlow)
      allFlows.push({
        flow: taskToSplitFlow,
        sourceElement: task,
        targetElement: splitGateway,
      })
      plane.planeElement.push(
        moddle.create('bpmndi:BPMNEdge', {
          id: `${taskToSplitFlowId}_di`,
          bpmnElement: taskToSplitFlow,
          waypoint: [
            moddle.create('dc:Point', {
              x: stop.x + ELEMENT_WIDTH,
              y: stop.y + ELEMENT_HEIGHT / 2,
            }),
            moddle.create('dc:Point', {
              x: stop.x + ELEMENT_WIDTH + 20,
              y: stop.y + ELEMENT_HEIGHT / 2,
            }),
          ],
        })
      )
    }
  }

  // Create sequence flows for all unique edges
  // Now edges connect: source (or source's split gateway) -> target's merge gateway (or target)
  let flowIndex = 0
  for (const [edgeKey, edge] of uniqueEdges) {
    flowIndex++
    const flowId = `Flow_${flowIndex}`

    // Determine actual source element
    let sourceElement: any
    let sourceX: number
    let sourceY: number

    if (edge.fromStopId === 'START_GATEWAY') {
      sourceElement = bpmnElements.get('START_GATEWAY')
      sourceX = START_X - 25 + GATEWAY_SIZE
      sourceY = centerY
    } else {
      const sourceStop = uniqueStops.get(edge.fromStopId)!
      // If source has a split gateway, connect from the split gateway
      if (stopsNeedingSplitGateway.has(edge.fromStopId)) {
        sourceElement = bpmnElements.get(`SPLIT_${edge.fromStopId}`)
        sourceX = sourceStop.x + ELEMENT_WIDTH + 20 + GATEWAY_SIZE
        sourceY = sourceStop.y + ELEMENT_HEIGHT / 2
      } else {
        sourceElement = bpmnElements.get(edge.fromStopId)
        sourceX = sourceStop.x + ELEMENT_WIDTH
        sourceY = sourceStop.y + ELEMENT_HEIGHT / 2
      }
    }

    // Determine actual target element
    let targetElement: any
    let targetX: number
    let targetY: number

    if (edge.toStopId === 'END_GATEWAY') {
      targetElement = bpmnElements.get('END_GATEWAY')
      targetX = maxX + HORIZONTAL_SPACING
      targetY = centerY
    } else {
      const targetStop = uniqueStops.get(edge.toStopId)!
      // If target has a merge gateway, connect to the merge gateway
      if (stopsNeedingMergeGateway.has(edge.toStopId)) {
        targetElement = bpmnElements.get(`MERGE_${edge.toStopId}`)
        targetX = targetStop.x - GATEWAY_SIZE - 20
        targetY = targetStop.y + ELEMENT_HEIGHT / 2
      } else {
        targetElement = bpmnElements.get(edge.toStopId)
        targetX = targetStop.x
        targetY = targetStop.y + ELEMENT_HEIGHT / 2
      }
    }

    if (!sourceElement || !targetElement) {
      console.warn(`Missing element for edge: ${edgeKey}`)
      continue
    }

    const flow = moddle.create('bpmn:SequenceFlow', {
      id: flowId,
      sourceRef: sourceElement,
      targetRef: targetElement,
    })
    process.flowElements.push(flow)
    allFlows.push({
      flow,
      sourceElement,
      targetElement,
    })

    plane.planeElement.push(
      moddle.create('bpmndi:BPMNEdge', {
        id: `${flowId}_di`,
        bpmnElement: flow,
        waypoint: [
          moddle.create('dc:Point', { x: sourceX, y: sourceY }),
          moddle.create('dc:Point', { x: targetX, y: targetY }),
        ],
      })
    )
  }

  // Wire up incoming/outgoing references for all flows
  for (const { flow, sourceElement, targetElement } of allFlows) {
    sourceElement.outgoing.push(flow)
    targetElement.incoming.push(flow)
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
  console.log(`Unique stops: ${uniqueStops.size}`)
  console.log(`Unique edges: ${uniqueEdges.size}`)
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
