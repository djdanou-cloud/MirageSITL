import type { BodyTruth } from "@mirage/wasm-bet/backend";
/** A configured contact backend owns ALL body integration for that session. */
export interface ContactBackend {
  readonly integrationOwner: "rapier";
  readonly highRateCertified: boolean;
  stepInto(wrenchBody: Float64Array, dt: number, out: BodyTruth): boolean;
  impulseInto(out: ContactImpulse): void;
  dispose(): void;
}
export interface ContactImpulse {
  pointBody: Float64Array;
  impulseNed: Float64Array;
  dt: number;
}
