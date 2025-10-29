// Decode GTFS Realtime (protobuf) feed and save as JSON
import * as GtfsRealtimeBindings from 'gtfs-realtime-bindings'
import { writeFile } from 'fs/promises'

const baseUrl = 'https://api.odpt.org/api/v4/gtfs/realtime/ToeiBus'

const u = new URL(baseUrl)
u.searchParams.set('acl:consumerKey', process.env.CONSUMER_KEY!)

const response = await fetch(u.toString(), {
  method: 'GET',
})

if (!response.ok) {
  throw new Error(`HTTP ${response.status} ${response.statusText}`)
}

// Read the protobuf payload as an ArrayBuffer
const arrayBuffer = await response.arrayBuffer()
const buffer = new Uint8Array(arrayBuffer)

// Decode using gtfs-realtime-bindings
const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer)

// Convert to plain JSON-friendly object
const feedObject = GtfsRealtimeBindings.transit_realtime.FeedMessage.toObject(
  feed,
  {
    longs: String,
    enums: String,
    bytes: String,
    defaults: true,
  }
)

// Save to file
const outPath = './toei-bus.json'
await writeFile(outPath, JSON.stringify(feedObject, null), 'utf-8')

console.log(`Saved GTFS Realtime JSON to ${outPath}`)

// Also save the raw unparsed protobuf data
const rawOutPath = './toei-bus.pb'
await writeFile(rawOutPath, buffer)
console.log(`Saved raw GTFS Realtime protobuf to ${rawOutPath}`)
