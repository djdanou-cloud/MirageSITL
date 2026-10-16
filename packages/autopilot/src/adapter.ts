export type AutopilotBackend = "external-sitl" | "wasm-sitl" | "hitl";
export type AutopilotState =
  | "disconnected"
  | "initializing"
  | "warming"
  | "ready"
  | "running"
  | "fault";
export interface AutopilotHealth {
  epoch: number;
  sampleTimeMs: number;
  ekfHealthy: boolean;
  linkHealthy: boolean;
  source: "autopilot";
}
export interface AutopilotAdapter {
  readonly backend: AutopilotBackend;
  disconnect(): Promise<void>;
  reset(epoch: number): void;
}
