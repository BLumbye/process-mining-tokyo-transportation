import { loadAndPreprocessStaticData, XESTrace } from '../xes-converter'
import { loadLog } from './common'

interface SkippedStop {
  stopSequence: number
  stopId: string
  stopName: string
}

interface SkippedStopsIssue {
  trace: XESTrace
  skippedStops: SkippedStop[]
  totalStopsInRoute: number
  observedStops: number
}

async function analyseSkippedStops() {
  if (Bun.argv.length < 3) {
    console.log(
      'Needs base file name as argument. Correct usage: bun run skipped-stops.ts <base-file-name>'
    )
    process.exit(1)
  }
  const baseFileName = Bun.argv[2]

  console.log(`Loading log for ${baseFileName}...`)
  const log = await loadLog(baseFileName)
  console.log(`Loaded ${log.length} traces`)

  console.log(`Loading static data for ${baseFileName}...`)
  const staticData = await loadAndPreprocessStaticData(baseFileName)

  // Build a map of trip_id -> all stop sequences for that trip
  const tripStopSequences = new Map<string, Set<number>>()
  for (const [key] of staticData.stopTimesByTripAndSequence) {
    const [tripId, stopSequenceStr] = key.split(':')
    const stopSequence = parseInt(stopSequenceStr, 10)
    if (!tripStopSequences.has(tripId)) {
      tripStopSequences.set(tripId, new Set())
    }
    tripStopSequences.get(tripId)!.add(stopSequence)
  }

  console.log(`\nAnalysing skipped stops...\n`)

  const issues: SkippedStopsIssue[] = []
  let totalSkippedStops = 0

  for (const trace of log) {
    if (trace.events.length === 0) continue

    const expectedStops = tripStopSequences.get(trace.tripId)
    if (expectedStops === undefined) {
      console.log(`Warning: Trip ${trace.tripId} not found in static data`)
      continue
    }

    // Get the set of observed stop sequences
    const observedStopSequences = new Set(
      trace.events.map((e) => e.stopSequence)
    )

    // Find the range of observed stops (from first to last observed)
    const sortedObserved = [...observedStopSequences].sort((a, b) => a - b)
    const firstObserved = sortedObserved[0]
    const lastObserved = sortedObserved[sortedObserved.length - 1]

    // Find skipped stops (expected stops within the observed range that are missing)
    const skippedStops: SkippedStop[] = []
    for (const expectedSeq of expectedStops) {
      // Only check stops within the observed range
      if (
        expectedSeq >= firstObserved &&
        expectedSeq <= lastObserved &&
        !observedStopSequences.has(expectedSeq)
      ) {
        // Look up stop info
        const key = `${trace.tripId}:${expectedSeq}`
        const stopInfo = staticData.stopTimesByTripAndSequence.get(key)
        if (stopInfo) {
          const stop = staticData.stopsById.get(stopInfo.stopId)
          const stopName = stop?.stop_name ?? 'Unknown'

          // Try to get English translation
          let englishName: string | undefined
          if (baseFileName.includes('Bus')) {
            englishName = staticData.translationsByRecordId.get(stopInfo.stopId)
          } else {
            englishName = staticData.translationsByFieldValue.get(stopName)
          }

          skippedStops.push({
            stopSequence: expectedSeq,
            stopId: stopInfo.stopId,
            stopName: englishName ?? stopName,
          })
        }
      }
    }

    if (skippedStops.length > 0) {
      // Sort by stop sequence
      skippedStops.sort((a, b) => a.stopSequence - b.stopSequence)

      issues.push({
        trace,
        skippedStops,
        totalStopsInRoute: expectedStops.size,
        observedStops: observedStopSequences.size,
      })
      totalSkippedStops += skippedStops.length
    }
  }

  // Log all instances
  console.log('='.repeat(80))
  console.log('SKIPPED STOPS INSTANCES')
  console.log('='.repeat(80))

  for (const issue of issues) {
    console.log(`\nTrace ID: ${issue.trace.id}`)
    console.log(`  Trip ID: ${issue.trace.tripId}`)
    console.log(`  Line: ${issue.trace.lineName}`)
    console.log(
      `  Route stops: ${issue.totalStopsInRoute}, Observed: ${issue.observedStops}, Skipped: ${issue.skippedStops.length}`
    )
    console.log(`  Skipped stops:`)
    for (const stop of issue.skippedStops) {
      console.log(
        `    - Sequence ${stop.stopSequence}: ${stop.stopName} (${stop.stopId})`
      )
    }
  }

  // Log summary
  console.log('\n' + '='.repeat(80))
  console.log('SUMMARY')
  console.log('='.repeat(80))

  console.log(`\nTotal traces analysed: ${log.length}`)
  console.log(`Traces with skipped stops: ${issues.length}`)
  console.log(`Total skipped stops: ${totalSkippedStops}`)
  console.log(
    `Percentage of traces with skipped stops: ${((issues.length / log.length) * 100).toFixed(2)}%`
  )

  if (issues.length > 0) {
    const avgSkippedPerIssue = totalSkippedStops / issues.length
    console.log(
      `Average skipped stops per affected trace: ${avgSkippedPerIssue.toFixed(2)}`
    )
  }

  // Group by line for additional insights
  const issuesByLine = new Map<string, SkippedStopsIssue[]>()
  for (const issue of issues) {
    const lineName = issue.trace.lineName
    if (!issuesByLine.has(lineName)) {
      issuesByLine.set(lineName, [])
    }
    issuesByLine.get(lineName)!.push(issue)
  }

  console.log(`\nSkipped stops by line:`)
  const sortedLines = [...issuesByLine.entries()].sort(
    (a, b) => b[1].length - a[1].length
  )
  const tableData = sortedLines.map(([lineName, lineIssues]) => {
    const totalSkipped = lineIssues.reduce(
      (sum, i) => sum + i.skippedStops.length,
      0
    )
    return {
      Line: lineName,
      'Traces Affected': lineIssues.length,
      'Total Skipped': totalSkipped,
      'Avg Skipped/Trace': (totalSkipped / lineIssues.length).toFixed(2),
    }
  })
  console.table(tableData)

  // Analyze which stops are most frequently skipped
  const skipCountByStop = new Map<string, { name: string; count: number }>()
  for (const issue of issues) {
    for (const stop of issue.skippedStops) {
      const key = stop.stopId
      if (!skipCountByStop.has(key)) {
        skipCountByStop.set(key, { name: stop.stopName, count: 0 })
      }
      skipCountByStop.get(key)!.count++
    }
  }

  console.log(`\nMost frequently skipped stops (top 20):`)
  const sortedStops = [...skipCountByStop.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20)

  const stopTableData = sortedStops.map(([stopId, { name, count }]) => ({
    'Stop ID': stopId,
    'Stop Name': name,
    'Times Skipped': count,
  }))
  console.table(stopTableData)
}

if (import.meta.main) {
  analyseSkippedStops()
}
