import { XESEvent, XESTrace } from '../xes-converter'
import { loadLog } from './common'

interface TimeOrderIssue {
  earlierEvent: XESEvent
  laterEvent: XESEvent
}

interface WrongTimeIssue {
  trace: XESTrace
  issues: TimeOrderIssue[]
}

async function analyseWrongTime() {
  if (Bun.argv.length < 3) {
    console.log(
      'Needs base file name as argument. Correct usage: bun run wrong-time.ts <base-file-name>'
    )
    process.exit(1)
  }
  const baseFileName = Bun.argv[2]

  console.log(`Loading log for ${baseFileName}...`)
  const log = await loadLog(baseFileName)
  console.log(`Loaded ${log.length} traces`)

  console.log(`\nAnalysing wrong time order...\n`)

  const issues: WrongTimeIssue[] = []
  let totalTimeIssues = 0

  for (const trace of log) {
    if (trace.events.length < 2) continue

    // Sort events by stop sequence
    const sortedBySequence = [...trace.events].sort(
      (a, b) => a.stopSequence - b.stopSequence
    )

    const traceIssues: TimeOrderIssue[] = []

    // Check each consecutive pair of events
    for (let i = 0; i < sortedBySequence.length - 1; i++) {
      const earlierEvent = sortedBySequence[i]
      const laterEvent = sortedBySequence[i + 1]

      const earlierTime = new Date(earlierEvent.afterTimestamp).getTime()
      const laterTime = new Date(laterEvent.afterTimestamp).getTime()

      // If the earlier stop (by sequence) has a later timestamp, that's wrong
      if (earlierTime > laterTime) {
        traceIssues.push({
          earlierEvent,
          laterEvent,
        })
      }
    }

    if (traceIssues.length > 0) {
      issues.push({
        trace,
        issues: traceIssues,
      })
      totalTimeIssues += traceIssues.length
    }
  }

  // Log all instances
  console.log('='.repeat(80))
  console.log('WRONG TIME ORDER INSTANCES')
  console.log('='.repeat(80))

  for (const issue of issues) {
    console.log(`\nTrace ID: ${issue.trace.id}`)
    console.log(`  Trip ID: ${issue.trace.tripId}`)
    console.log(`  Line: ${issue.trace.lineName}`)
    console.log(`  Time order issues (${issue.issues.length}):`)

    for (const timeIssue of issue.issues) {
      const earlierTime = new Date(timeIssue.earlierEvent.afterTimestamp)
      const laterTime = new Date(timeIssue.laterEvent.afterTimestamp)
      const timeDiffMs = earlierTime.getTime() - laterTime.getTime()
      const timeDiffSec = Math.abs(timeDiffMs / 1000)

      console.log(
        `    - Stop ${timeIssue.earlierEvent.stopSequence} (${timeIssue.earlierEvent.stopName}) @ ${timeIssue.earlierEvent.afterTimestamp}`
      )
      console.log(
        `      has LATER time than Stop ${timeIssue.laterEvent.stopSequence} (${timeIssue.laterEvent.stopName}) @ ${timeIssue.laterEvent.afterTimestamp}`
      )
      console.log(`      Time difference: ${timeDiffSec.toFixed(1)} seconds`)
    }
  }

  // Log summary
  console.log('\n' + '='.repeat(80))
  console.log('SUMMARY')
  console.log('='.repeat(80))

  console.log(`\nTotal traces analysed: ${log.length}`)
  console.log(`Traces with wrong time order: ${issues.length}`)
  console.log(`Total time order violations: ${totalTimeIssues}`)
  console.log(
    `Percentage of traces with wrong time order: ${((issues.length / log.length) * 100).toFixed(2)}%`
  )

  if (issues.length > 0) {
    const avgIssuesPerTrace = totalTimeIssues / issues.length
    console.log(
      `Average violations per affected trace: ${avgIssuesPerTrace.toFixed(2)}`
    )

    // Calculate time difference statistics
    const allTimeDiffs: number[] = []
    for (const issue of issues) {
      for (const timeIssue of issue.issues) {
        const earlierTime = new Date(timeIssue.earlierEvent.afterTimestamp)
        const laterTime = new Date(timeIssue.laterEvent.afterTimestamp)
        const timeDiffSec =
          Math.abs(earlierTime.getTime() - laterTime.getTime()) / 1000
        allTimeDiffs.push(timeDiffSec)
      }
    }

    allTimeDiffs.sort((a, b) => a - b)
    const minDiff = allTimeDiffs[0]
    const maxDiff = allTimeDiffs[allTimeDiffs.length - 1]
    const avgDiff =
      allTimeDiffs.reduce((sum, d) => sum + d, 0) / allTimeDiffs.length
    const medianDiff = allTimeDiffs[Math.floor(allTimeDiffs.length / 2)]

    console.log(`\nTime difference statistics (seconds):`)
    console.log(`  Min: ${minDiff.toFixed(1)}`)
    console.log(`  Max: ${maxDiff.toFixed(1)}`)
    console.log(`  Average: ${avgDiff.toFixed(1)}`)
    console.log(`  Median: ${medianDiff.toFixed(1)}`)
  }

  // Group by line for additional insights
  const issuesByLine = new Map<string, WrongTimeIssue[]>()
  for (const issue of issues) {
    const lineName = issue.trace.lineName
    if (!issuesByLine.has(lineName)) {
      issuesByLine.set(lineName, [])
    }
    issuesByLine.get(lineName)!.push(issue)
  }

  console.log(`\nWrong time order by line:`)
  const sortedLines = [...issuesByLine.entries()].sort(
    (a, b) => b[1].length - a[1].length
  )
  const tableData = sortedLines.map(([lineName, lineIssues]) => {
    const totalViolations = lineIssues.reduce(
      (sum, i) => sum + i.issues.length,
      0
    )
    return {
      Line: lineName,
      'Traces Affected': lineIssues.length,
      'Total Violations': totalViolations,
      'Avg Violations/Trace': (totalViolations / lineIssues.length).toFixed(2),
    }
  })
  console.table(tableData)

  // Analyze which stop pairs have the most issues
  const stopPairIssues = new Map<
    string,
    { stop1: string; stop2: string; count: number }
  >()
  for (const issue of issues) {
    for (const timeIssue of issue.issues) {
      const key = `${timeIssue.earlierEvent.stopId}->${timeIssue.laterEvent.stopId}`
      if (!stopPairIssues.has(key)) {
        stopPairIssues.set(key, {
          stop1: timeIssue.earlierEvent.stopName,
          stop2: timeIssue.laterEvent.stopName,
          count: 0,
        })
      }
      stopPairIssues.get(key)!.count++
    }
  }

  console.log(`\nMost frequent stop pairs with wrong time order (top 20):`)
  const sortedPairs = [...stopPairIssues.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20)

  const pairTableData = sortedPairs.map(([, { stop1, stop2, count }]) => ({
    'Earlier Stop': stop1,
    'Later Stop': stop2,
    Occurrences: count,
  }))
  console.table(pairTableData)
}

if (import.meta.main) {
  analyseWrongTime()
}
