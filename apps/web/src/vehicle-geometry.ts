// Display geometry of the demo quad mesh (FlightScene.tsx), shared with the
// mounted FPV camera so the camera sits on the drawn body rather than inside it.
// The mesh is drawn MODEL_HEIGHT_OFFSET_M above the NED reference point of the
// physics pose; the body box is 0.5 m long, so its nose is 0.25 m ahead.

/** Hub height of the demo mesh above its NED reference point, m. */
export const MODEL_HEIGHT_OFFSET_M = 0.28;
/** Distance from the reference point to the front face of the body box, m. */
export const BODY_NOSE_FORWARD_M = 0.25;
