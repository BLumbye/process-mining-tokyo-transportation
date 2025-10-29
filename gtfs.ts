// Decode GTFS Realtime (protobuf) feed and save as JSON
import * as GtfsRealtimeBindings from "gtfs-realtime-bindings"
import { appendFile } from "fs/promises"


export async function fetchAndSaveGtfsData(baseUrl: string, filePath: string) {
  const u = new URL(baseUrl)
  u.searchParams.set("acl:consumerKey", process.env.BASIC_TOKEN!)

  const response = await fetch(u.toString(), {
    method: "GET",
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

  // function busJSONReplacer(key: string, value: any) {
  //   // Remove empty objects and arrays
  //   switch (value) {
  //     case "multiCarriageDetails":
  //     case "licensePlate":
  //       return undefined
  //   }

  //   return value
  // }


  // Save to file
  await appendFile(filePath, JSON.stringify(feedObject, null) + "\n", "utf-8")
}