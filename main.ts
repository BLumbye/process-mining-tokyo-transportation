import { fetchAndSaveGtfsData } from './gtfs'
const path = require('bun:path')
import { mkdir } from 'node:fs/promises'

const RUN_EVERY_X_SECONDS = 30

const dataObj = [
  {
    resource: 'https://api.odpt.org/api/v4/gtfs/realtime/ToeiBus',
    baseFileName: 'ToeiBus',
    token: process.env.BASIC_TOKEN!,
  },
  {
    resource:
      'https://api.odpt.org/api/v4/gtfs/realtime/toei_odpt_train_vehicle',
    baseFileName: 'ToeiTrain',
    token: process.env.BASIC_TOKEN!,
  },
  {
    resource:
      'https://api-challenge.odpt.org/api/v4/gtfs/realtime/tobu_odpt_train_vehicle',
    baseFileName: 'TobuTrain',
    token: process.env.CHALLENGE_2025_TOKEN!,
  },
]

// Create output directory if it doesn't exist
await mkdir(process.env.OUTPUT_DIR!, { recursive: true })

setInterval(() => {
  for (const data of dataObj) {
    const baseUrl = data.resource
    const currentDate = new Date().toISOString().split('T')[0]
    const filePath = path.join(
      process.env.OUTPUT_DIR,
      `${currentDate}-${data.baseFileName}.jsonl`
    )

    fetchAndSaveGtfsData(baseUrl, filePath, data.token)
      .then(() => {
        console.log(`Successfully saved new to ${filePath}`)
      })
      .catch((e) => {
        const message = `Error trying to fetch data for ${data.baseFileName}`
        console.error(message + '\n', e)
        gotify(message).catch((err) => console.error('gotify failed', err))
      })
  }
}, RUN_EVERY_X_SECONDS * 1000)

async function gotify(message: string): Promise<void> {
  if (!process.env.GOTIFY_URL || !process.env.GOTIFY_TOKEN) return

  const u = new URL(`${process.env.GOTIFY_URL}/message`)
  u.searchParams.set('token', process.env.GOTIFY_TOKEN)

  const body = new URLSearchParams({ message }).toString()

  const res = await fetch(u.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!res.ok) {
    throw new Error(`Gotify failed: ${res.status} ${res.statusText}`)
  }
}
