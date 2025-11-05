export interface OutputFile {
  entity: Entity[]
  header: Header
}

export interface Entity {
  id: string
  isDeleted: boolean
  tripUpdate: null
  vehicle: EntityVehicle
  alert: null
}

export interface EntityVehicle {
  multiCarriageDetails: any[]
  trip: Trip
  position: Position
  currentStopSequence: number
  currentStatus: CurrentStatus
  timestamp: string
  congestionLevel: CongestionLevel
  stopId: string
  vehicle: VehicleVehicle
  occupancyStatus: OccupancyStatus
  occupancyPercentage: number
}

export enum CongestionLevel {
  UnknownCongestionLevel = 'UNKNOWN_CONGESTION_LEVEL',
}

export enum CurrentStatus {
  InTransitTo = 'IN_TRANSIT_TO',
  StoppedAt = 'STOPPED_AT',
}

export enum OccupancyStatus {
  Empty = 'EMPTY',
}

export interface Position {
  latitude: number
  longitude: number
  bearing: number
  odometer: number
  speed: number
}

export interface Trip {
  tripId: string
  startTime: string
  startDate: string
  scheduleRelationship: ScheduleRelationship
  routeId: string
  directionId: number
}

export enum ScheduleRelationship {
  Scheduled = 'SCHEDULED',
}

export interface VehicleVehicle {
  id: string
  label: string
  licensePlate: string
}

export interface Header {
  gtfsRealtimeVersion: string
  incrementality: string
  timestamp: string
}
