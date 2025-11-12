import readline from "readline";
import { readdir, writeFile } from "node:fs/promises";
import { OutputFile } from "./output-file-types";
import { create } from "xmlbuilder2";
import path from "node:path";
import { createReadStream } from "node:fs";
import { parse } from "csv-parse/sync";

interface XESTrace {
  id: string;
  tripId: string;
  routeId: string;
  lineName: string;
  events: XESEvent[];
}

interface XESEvent {
  stopSequence: number;
  stopId: string;
  stopName: string;
  // beforeTimestamp: string
  afterTimestamp: string;
  // latitude: number;
  // longitude: number;
}

// const baseFileTypes = ['TobuTrain', 'ToeiBus', 'ToeiTrain']
const baseFileTypes = ["ToeiBus"];

for (const baseFileType of baseFileTypes) {
  convertXES(baseFileType);
}

async function convertXES(baseFileName: string): Promise<void> {
  console.log(`Starting ${baseFileName}`);

  // Find all files in output
  const allFiles = await readdir(process.env.OUTPUT_DIR!);
  const filteredFiles = allFiles.filter((file) =>
    file.includes(`${baseFileName}.jsonl`)
  );

  const traces = new Map<string, XESTrace>();
  const previousStates = new Map<string, { stop: number; timestamp: string }>();

  // Load static files
  const tripsCsv = await Bun.file(`./${baseFileName}-static/trips.txt`).text();
  const routesCsv = await Bun.file(
    `./${baseFileName}-static/routes.txt`
  ).text();
  const stopsCsv = await Bun.file(`./${baseFileName}-static/stops.txt`).text();
  const stopTimesCsv = await Bun.file(
    `./${baseFileName}-static/stop_times.txt`
  ).text();
  const translationsCsv = await Bun.file(
    `./${baseFileName}-static/translations.txt`
  ).text();

  const trips = parse(tripsCsv, {
    columns: true,
    skip_empty_lines: true,
  }) as Record<string, string>[];
  const routes = parse(routesCsv, {
    columns: true,
    skip_empty_lines: true,
  }) as Record<string, string>[];
  const translations = parse(translationsCsv, {
    columns: true,
    skip_empty_lines: true,
  }) as Record<string, string>[];
  const stops = parse(stopsCsv, {
    columns: true,
    skip_empty_lines: true,
  }) as Record<string, string>[];
  const stopTimes = parse(stopTimesCsv, {
    columns: true,
    skip_empty_lines: true,
  }) as Record<string, string>[];

  // Go through files
  for (let fileName of filteredFiles) {
    console.log(`Processing ${fileName}`);

    const rl = readline.createInterface({
      input: createReadStream(path.join(process.env.OUTPUT_DIR!, fileName)),
      crlfDelay: Infinity,
    });

    //setup data structure for XML/XES format
    let lineNo = 1;
    for await (const line of rl) {
      console.log(`Processing line ${lineNo} of ${fileName}`);
      lineNo++;
      const lineJson = JSON.parse(line) as OutputFile;
      for (const entity of lineJson.entity) {
        const nextState = {
          stop: entity.vehicle.currentStopSequence,
          timestamp: entity.vehicle.timestamp,
        };

        if (previousStates.has(entity.id)) {
          const previousState = previousStates.get(entity.id)!;
          if (previousState.stop !== nextState.stop) {
            // Bus id

            const lookupStopId = stopTimes.find(
              (stopTime) =>
                stopTime.trip_id === entity.vehicle.trip.tripId &&
                stopTime.stop_sequence === nextState.stop.toString()
            )?.stop_id;

            if (lookupStopId == undefined) {
              continue;
            }

            const lookupStopName = stops.find(
              (stop) => stop.stop_id === lookupStopId
            )!.stop_name;

            let lookupStopEnglishName: string | undefined;

            if (baseFileName.includes("Bus")) {
              lookupStopEnglishName = translations.find(
                (translation) =>
                  translation.record_id === lookupStopId &&
                  translation.language === "en"
              )!.translation;

              if (lookupStopEnglishName == undefined) {
                throw Error(
                  `Missing English translation for stop name ${lookupStopName}. Stop id: ${lookupStopId}`
                );
              }
            } else {
              lookupStopEnglishName = translations.find(
                (translation) =>
                  translation.field_value === lookupStopName &&
                  translation.language === "en"
              )!.translation;
            }

            const event: XESEvent = {
              stopSequence: nextState.stop,
              stopId: lookupStopId,
              stopName: lookupStopEnglishName,
              afterTimestamp: nextState.timestamp,
              // latitude: entity.vehicle.position.latitude,
              // longitude: entity.vehicle.position.longitude,
            };

            if (traces.has(entity.id)) {
              const trace = traces.get(entity.id)!;
              trace.events.push(event);
            } else {
              // traceId is not empty string (but routeIdcan be)
              const tripId = entity.vehicle.trip.tripId;
              const routeId = entity.vehicle.trip.routeId;

              const lookupRouteId = trips.find(
                (trip) => trip.trip_id === tripId
              )!;

              // routeId is given on some files (double check they are the same if given)
              if (routeId !== "" && routeId !== lookupRouteId.route_id) {
                throw Error(
                  "lookup route id doesn't match route id in source json"
                );
              }

              const lookupLongRouteName = routes.find(
                (route) => route.route_id === lookupRouteId.route_id
              )!.route_long_name;

              let lookupLongRouteEnglishName: string | undefined;
              if (baseFileName.includes("Bus")) {
                lookupLongRouteEnglishName = translations.find(
                  (translation) =>
                    translation.field_value === lookupRouteId.trip_headsign &&
                    translation.language === "en"
                )!.translation;

                if (lookupLongRouteEnglishName == undefined) {
                  throw Error(
                    `Missing English translation for stop name ${lookupLongRouteName}`
                  );
                }
              } else {
                lookupLongRouteEnglishName = translations.find(
                  (translation) =>
                    translation.field_value === lookupLongRouteName &&
                    translation.language === "en"
                )!.translation;
              }

              traces.set(entity.id, {
                id: entity.id,
                tripId: tripId,
                routeId: lookupRouteId.route_id,
                lineName: lookupLongRouteEnglishName,
                events: [event],
              });
            }
          }
        }

        previousStates.set(entity.id, nextState);
      }
    }
  }

  // Convert to XES format
  const xes = create({ version: "1.0", encoding: "UTF-8" })
    .ele("log", {
      "xes.version": "1.0",
      "xes.features": "nested-attributes",
      "openxes.version": "1.0RC7",
      xmlns: "http://www.xes-standard.org/",
    })
    .ele("extension", {
      name: "Time",
      prefix: "time",
      uri: "http://www.xes-standard.org/time.xesext",
    })
    .up()
    .ele("extension", {
      name: "Concept",
      prefix: "concept",
      uri: "http://www.xes-standard.org/concept.xesext",
    })
    .up()
    .ele("string", {
      key: "concept:name",
      value: baseFileName,
    })
    .up();

  // Add traces
  for (const trace of traces.values()) {
    const traceElement = xes
      .ele("trace")
      .ele("string", { key: "concept:name", value: trace.id })
      .ele("string", { key: "tripId", value: trace.tripId })
      .ele("string", { key: "routeId", value: trace.routeId })
      .ele("string", { key: "lineName", value: trace.lineName })
      .up();

    // Add events
    for (const event of trace.events) {
      const eventElement = traceElement.ele("event");
      eventElement.ele("string", {
        key: "concept:name",
        value: "currentStopSequenceChanged",
      });
      eventElement.ele("date", {
        key: "time:timestamp",
        value: new Date(Number(event.afterTimestamp) * 1000).toISOString(),
      });
      eventElement.ele("int", {
        key: "stopSequence",
        values: event.stopSequence,
      });
      eventElement.ele("string", {
        key: "stopId",
        value: event.stopId,
      });
      eventElement.ele("string", {
        key: "stopName",
        value: event.stopName,
      });

      // eventElement.ele("int", {
      //   key: "fromStop",
      //   value: event.fromStop,
      // });
      // eventElement.ele("int", {
      //   key: "toStop",
      //   value: event.toStop,
      // });
    }
  }

  const outputFile = path.join(process.env.OUTPUT_DIR!, `${baseFileName}.xes`);
  writeFile(outputFile, xes.end({ prettyPrint: true }), "utf-8");
  console.log(`Finished ${baseFileName}, output to ${outputFile}`);
}

/*
{
  "id": "100009150",
  "isDeleted": false,
  "tripUpdate": null,
  "vehicle": {
    "multiCarriageDetails": [],
    "trip": {
      "tripId": "100009150",
      "startTime": "",
      "startDate": "20251030",
      "scheduleRelationship": "SCHEDULED",
      "routeId": "",
      "directionId": 0
    },
    "position": {
      "latitude": 35.71192169189453,
      "longitude": 139.79835510253906,
      "bearing": 0,
      "odometer": 0,
      "speed": 0
    },
    "currentStopSequence": 1,
    "currentStatus": "STOPPED_AT",
    "timestamp": "1761830460",
    "congestionLevel": "UNKNOWN_CONGESTION_LEVEL",
    "stopId": "",
    "vehicle": {
      "id": "100009150",
      "label": "",
      "licensePlate": ""
    },
    "occupancyStatus": "EMPTY",
    "occupancyPercentage": 0
  },
  "alert": null
},
*/

/* 
<log xes.version="1.0" xes.features="nested-attributes" openxes.version="1.0RC7" xmlns="http://www.xes-standard.org/">
	<extension name="Organizational" prefix="org" uri="http://www.xes-standard.org/org.xesext"/>
	<extension name="Time" prefix="time" uri="http://www.xes-standard.org/time.xesext"/>
	<extension name="Lifecycle" prefix="lifecycle" uri="http://www.xes-standard.org/lifecycle.xesext"/>
	<extension name="Concept" prefix="concept" uri="http://www.xes-standard.org/concept.xesext"/>
	<string key="concept:name" value="tmp-process"/>
	<trace>
		<string key="concept:name" value="case_868"/>
		<event>
			<string key="org:resource" value="admin-2"/>
			<int key="cost" value="14"/>
			<string key="concept:name" value="record issue"/>
			<date key="time:timestamp" value="1970-01-01T01:00:00+01:00"/>
		</event>
		<event>
			<string key="org:resource" value="inspector-7"/>
			<int key="cost" value="407"/>
			<string key="concept:name" value="inspection"/>
			<string key="intervention" value="false"/>
			<int key="urgency" value="2"/>
			<date key="time:timestamp" value="1970-01-01T02:00:00+01:00"/>
		</event>
		<event>
			<int key="cost" value="10"/>
			<string key="org:resource" value="manager-1"/>
			<string key="concept:name" value="action not required"/>
			<date key="time:timestamp" value="1970-01-01T03:00:00+01:00"/>
		</event>
		<event>
			<int key="cost" value="13"/>
			<string key="org:resource" value="admin-0"/>
			<string key="concept:name" value="issue completion"/>
			<date key="time:timestamp" value="1970-01-01T04:00:00+01:00"/>
		</event>
	</trace>

*/
