import { fetchAndSaveGtfsData } from "./gtfs";

const RUN_EVERY_X_SECONDS = 5;

const dataObj = [
    {
        "resource": "https://api.odpt.org/api/v4/gtfs/realtime/ToeiBus",
        "baseFileName": "ToeiBus",
    }
];



setInterval(() => {
    // log time
    for (const data of dataObj) {
        const baseUrl = data.resource;
        const filePath = new Date().toISOString().split('T')[0] + `-${data.baseFileName}.jsonl`;
        
        fetchAndSaveGtfsData(baseUrl, filePath).then(() => {
            console.log("test");
        });
    }

}, RUN_EVERY_X_SECONDS * 1000);
