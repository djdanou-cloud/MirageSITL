export type ShutterState = "idle" | "closed" | "calibrating" | "open";
export interface ThermalStatus {
  state: ShutterState;
  frameId: number;
  sensorTimeS: number;
  cycles: number;
  visible: boolean;
}
