import { fetchAndSaveGtfsData } from "./gtfs";
const path = require('bun:path');
import {mkdir} from 'node:fs/promises';



const RUN_EVERY_X_SECONDS = 5;

const dataObj = [
    {
        "resource": "https://api.odpt.org/api/v4/gtfs/realtime/ToeiBus",
        "baseFileName": "ToeiBus",
    },
];

// Create output directory if it doesn't exist
await mkdir(process.env.OUTPUT_DIR!, { recursive: true });


setInterval(() => {
    // log time
    for (const data of dataObj) {
        const baseUrl = data.resource;
        const currentDate = new Date().toISOString().split('T')[0];
        const filePath = path.join(process.env.OUTPUT_DIR, currentDate + `-${data.baseFileName}.jsonl`)

        // fetchAndSaveGtfsData(baseUrl, filePath).then(() => {
        //     console.log("test");
        // });
    }

}, RUN_EVERY_X_SECONDS * 1000);
