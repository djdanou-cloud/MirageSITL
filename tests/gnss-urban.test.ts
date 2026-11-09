import { describe, expect, it } from 'vitest';
import { enuOffset, nonLineOfSightShare, parseNavPosllh } from '@mirage/analysis/gnss-urban';

// TASK-117 (SPECS_SIMULATION_ENGINES "Logged urban position errors: smartLoc"): the error's geometry on a hand case, and the readers.
// WGS 84 at latitude 50° and height h = 100 m: a step of 0.001° north is (M + h)·Δφ and east (N + h)·cos φ·Δλ, with the meridian
// radius M = a(1 − e²)/(1 − e² sin²φ)^(3/2) and the prime vertical N = a/√(1 − e² sin²φ). Over 0.001° a chord and its arc differ by
// a few nanometres, and the curvature drops the up component by d²/(2R), about 1 mm, and tilts an east step north by about 0.5 mm.
describe('smartLoc urban errors', () => {
  const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f), phi = 50 * Math.PI / 180, s2 = Math.sin(phi) ** 2;
  const m = a * (1 - e2) / (1 - e2 * s2) ** 1.5, n = a / Math.sqrt(1 - e2 * s2), step = 0.001 * Math.PI / 180;
  it('puts a point north, east and up of its reference where WGS 84 says', () => {
    const north = enuOffset([50, 8, 100], [50.001, 8, 100]);
    expect(Math.abs(north[1] - (m + 100) * step)).toBeLessThan(1e-5);
    expect(Math.abs(north[0])).toBeLessThan(1e-9);
    const east = enuOffset([50, 8, 100], [50, 8.001, 100]);
    expect(Math.abs(east[0] - (n + 100) * Math.cos(phi) * step)).toBeLessThan(1e-5);
    expect(Math.abs(east[1])).toBeLessThan(1e-3);
    const up = enuOffset([50, 8, 100], [50, 8, 110.5]);
    expect(Math.abs(up[2] - 10.5)).toBeLessThan(1e-9);
    expect(Math.hypot(up[0], up[1])).toBeLessThan(1e-9);
  });
  it('reads NAV-POSLLH by its header and refuses another', () => {
    const header = ['GPSWeek [weeks]', 'GPSSecondsOfWeek [s]', 'Longitude (GT Lon) [deg]', 'x', 'Latitude (GT Lat) [deg]', 'x', 'Height above ellipsoid (GT Height) [m]',
      ...Array.from({ length: 10 }, () => 'x'), 'Longitude (lon) [deg]', 'Latitude (lat) [deg]', 'Height above ellipsoid (height) [m]', 'x', 'Horizontal accuracy estimate (hAcc) [m]', 'x'].join(';');
    const row = ['1900', '126641.5', '13.37', '0', '52.50', '0', '76', ...Array.from({ length: 10 }, () => '0'), '13.371', '52.501', '80', '38', '0.547', '-1'].join(';');
    const [epoch] = parseNavPosllh(`${header}\n${row}\n`);
    expect(epoch).toEqual({ week: 1900, secondsOfWeek: 126641.5, reference: [52.5, 13.37, 76], receiver: [52.501, 13.371, 80], hAccM: 0.547 });
    expect(() => parseNavPosllh(header.replace('Latitude (lat)', 'Latitude') + '\n' + row)).toThrow('column 19');
  });
  it('counts the labelled non-line-of-sight measurements', () => {
    expect(nonLineOfSightShare('h\n1;2;1\n1;2;0\n1;2;#\n1;2;1\n')).toEqual({ labelled: 3, share: 2 / 3 });
  });
});
