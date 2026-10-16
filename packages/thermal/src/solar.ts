/** Local ENU incidence; angles in radians, hour angle positive after solar noon.
 * Declination/hour angle are astronomical inputs, not inferred from wall time.
 * Visibility is geometric shadow transmission, not ambient occlusion.
 */
export function solarIncidence(
  latitudeRad: number,
  declinationRad: number,
  hourAngleRad: number,
  normalEnu: readonly [number, number, number],
  directNormalWm2: number,
  visibility: number,
): number {
  if (
    ![
      latitudeRad,
      declinationRad,
      hourAngleRad,
      ...normalEnu,
      directNormalWm2,
      visibility,
    ].every(Number.isFinite) ||
    Math.abs(latitudeRad) > Math.PI / 2 ||
    Math.abs(declinationRad) > Math.PI / 2 ||
    directNormalWm2 < 0 ||
    visibility < 0 ||
    visibility > 1 ||
    Math.abs(Math.hypot(...normalEnu) - 1) > 1e-9
  )
    throw new RangeError("Invalid solar geometry");
  const east = -Math.cos(declinationRad) * Math.sin(hourAngleRad);
  const north =
    Math.cos(latitudeRad) * Math.sin(declinationRad) -
    Math.sin(latitudeRad) * Math.cos(declinationRad) * Math.cos(hourAngleRad);
  const up =
    Math.sin(latitudeRad) * Math.sin(declinationRad) +
    Math.cos(latitudeRad) * Math.cos(declinationRad) * Math.cos(hourAngleRad);
  return up <= 0
    ? 0
    : directNormalWm2 *
        visibility *
        Math.max(
          0,
          east * normalEnu[0] + north * normalEnu[1] + up * normalEnu[2],
        );
}
