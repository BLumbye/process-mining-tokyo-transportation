import path from 'node:path'
import { XESTrace } from '../xes-converter'

/**
 * Load traces JSON file for a given base file type (e.g. 'ToeiBus').
 * Requires OUTPUT_DIR environment variable to be set.
 */
export async function loadLog(baseFileName: string): Promise<XESTrace[]> {
  if (!process.env.OUTPUT_DIR) {
    throw new Error('OUTPUT_DIR environment variable is not set')
  }

  const jsonPath = path.join(process.env.OUTPUT_DIR, `${baseFileName}.json`)
  const file = Bun.file(jsonPath)
  const data = await file.json()

  return data as XESTrace[]
}
