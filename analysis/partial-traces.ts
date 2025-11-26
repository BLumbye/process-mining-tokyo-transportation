import { loadAndPreprocessStaticData, XESTrace } from '../xes-converter'
import { loadLog } from './common'

interface PartialTraceIssue {
  trace: XESTrace
  expectedFirstStop: number
  expectedLastStop: number
  actualFirstStop: number
  actualLastStop: number
  missingStart: boolean
  missingEnd: boolean
}

async function analysePartialTraces() {
  if (Bun.argv.length < 3) {
    console.log(
      'Needs base file name as argument. Correct usage: bun run partial-traces.ts <base-file-name>'
    )
    process.exit(1)
  }
  const baseFileName = Bun.argv[2]

  console.log(`Loading log for ${baseFileName}...`)
  const log = await loadLog(baseFileName)
  console.log(`Loaded ${log.length} traces`)

  console.log(`Loading static data for ${baseFileName}...`)
  const staticData = await loadAndPreprocessStaticData(baseFileName)

  // Build a map of trip_id -> max stop sequence (last stop)
  const tripMaxStopSequence = new Map<string, number>()
  for (const [key] of staticData.stopTimesByTripAndSequence) {
    const [tripId, stopSequenceStr] = key.split(':')
    const stopSequence = parseInt(stopSequenceStr, 10)
    const currentMax = tripMaxStopSequence.get(tripId) ?? 0
    if (stopSequence > currentMax) {
      tripMaxStopSequence.set(tripId, stopSequence)
    }
  }

  console.log(`\nAnalysing partial traces...\n`)

  const issues: PartialTraceIssue[] = []

  for (const trace of log) {
    if (trace.events.length === 0) continue

    const expectedFirstStop = 1
    const expectedLastStop = tripMaxStopSequence.get(trace.tripId)

    if (expectedLastStop === undefined) {
      console.log(`Warning: Trip ${trace.tripId} not found in static data`)
      continue
    }

    // Sort events by stop sequence to get actual first and last
    const sortedEvents = [...trace.events].sort(
      (a, b) => a.stopSequence - b.stopSequence
    )
    const actualFirstStop = sortedEvents[0].stopSequence
    const actualLastStop = sortedEvents[sortedEvents.length - 1].stopSequence

    const missingStart = actualFirstStop !== expectedFirstStop
    const missingEnd = actualLastStop !== expectedLastStop

    if (missingStart || missingEnd) {
      issues.push({
        trace,
        expectedFirstStop,
        expectedLastStop,
        actualFirstStop,
        actualLastStop,
        missingStart,
        missingEnd,
      })
    }
  }

  // Log all instances
  console.log('='.repeat(80))
  console.log('PARTIAL TRACE INSTANCES')
  console.log('='.repeat(80))

  for (const issue of issues) {
    const issueType = []
    if (issue.missingStart) issueType.push('Missing Start')
    if (issue.missingEnd) issueType.push('Missing End')

    console.log(`\nTrace ID: ${issue.trace.id}`)
    console.log(`  Trip ID: ${issue.trace.tripId}`)
    console.log(`  Line: ${issue.trace.lineName}`)
    console.log(`  Issue: ${issueType.join(', ')}`)
    console.log(
      `  Expected stops: ${issue.expectedFirstStop} -> ${issue.expectedLastStop}`
    )
    console.log(
      `  Actual stops: ${issue.actualFirstStop} -> ${issue.actualLastStop}`
    )
    console.log(`  Number of events: ${issue.trace.events.length}`)
  }

  // Log summary
  console.log('\n' + '='.repeat(80))
  console.log('SUMMARY')
  console.log('='.repeat(80))

  const missingStartCount = issues.filter((i) => i.missingStart).length
  const missingEndCount = issues.filter((i) => i.missingEnd).length
  const missingBothCount = issues.filter(
    (i) => i.missingStart && i.missingEnd
  ).length

  console.log(`\nTotal traces analysed: ${log.length}`)
  console.log(`Total partial traces: ${issues.length}`)
  console.log(
    `  - Missing start (doesn't start at stop 1): ${missingStartCount}`
  )
  console.log(`  - Missing end (doesn't end at final stop): ${missingEndCount}`)
  console.log(`  - Missing both start and end: ${missingBothCount}`)
  console.log(
    `Percentage of partial traces: ${((issues.length / log.length) * 100).toFixed(2)}%`
  )

  // Group by line for additional insights
  const issuesByLine = new Map<string, PartialTraceIssue[]>()
  for (const issue of issues) {
    const lineName = issue.trace.lineName
    if (!issuesByLine.has(lineName)) {
      issuesByLine.set(lineName, [])
    }
    issuesByLine.get(lineName)!.push(issue)
  }

  console.log(`\nPartial traces by line:`)
  const sortedLines = [...issuesByLine.entries()].sort(
    (a, b) => b[1].length - a[1].length
  )
  const tableData = sortedLines.map(([lineName, lineIssues]) => ({
    Line: lineName,
    Total: lineIssues.length,
    'Missing Start': lineIssues.filter((i) => i.missingStart).length,
    'Missing End': lineIssues.filter((i) => i.missingEnd).length,
  }))
  console.table(tableData)
}

if (import.meta.main) {
  analysePartialTraces()
}
