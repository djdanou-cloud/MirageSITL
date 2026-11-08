// The Pavo's propeller measured in its own flights: at each BAT sample (about 10 Hz) where the aircraft moves slowly
// (EKF speed below 1.5 m/s in every axis) and is above 1.5 m by baro, total rotor thrust = -m * AccZ (body specific
// force, IMU 0, averaged over +-50 ms), the four logged ESC rpms give sum n^2 and sum n^3, and the battery power per
// motor, through a lossless ESC, equals the motor's (E + I R) I with E = rpm / KV, so the shaft power is E (I - I0).
// Assumptions, printed with the result: m = 0.169 kg, avionics current I_AV 0.4 A, motor no-load current I0 0.3 A,
// KV 8000, R 0.145 ohm, air temperature TK 298 K (density from baro pressure).
// Run: node --experimental-transform-types --no-warnings scripts/pavo/propeller-from-flight.mjs LOG...
import { readFileSync } from "node:fs";
const { readDataFlash } = await import("../../packages/dataflash/src/reader.ts");
const col = (g, n) => g.columns.find(c => c.name === n);
const M = 0.169, D = 0.05588, KV = 8000, I_AV = Number(process.env.I_AV ?? 0.4), I0 = Number(process.env.I0 ?? 0.3), TK = Number(process.env.TK ?? 298);
function series(g, vcol, filter) { const t = col(g, "TimeUS"), v = col(g, vcol), T = [], V = []; for (let i = 0; i < g.count; i++) if (!filter || filter(i)) { T.push(Number(t.values[i])); V.push(Number(v.values[i])); } return { T, V }; }
function mean(s, a, b) { let lo = 0, hi = s.T.length; while (lo < hi) { const m = (lo + hi) >> 1; if (s.T[m] < a) lo = m + 1; else hi = m; } let sum = 0, n = 0; for (let i = lo; i < s.T.length && s.T[i] <= b; i++) if (Number.isFinite(s.V[i])) { sum += s.V[i]; n++; } return n ? sum / n : NaN; }
const rows = [], elec = [];
for (const f of process.argv.slice(2)) {
  const log = readDataFlash(new Uint8Array(readFileSync(f)));
  const g = n => log.groups.find(x => x.name === n);
  const imu = g("IMU"), esc = g("ESC"), bat = g("BAT"), xkf = g("XKF1"), baro = g("BARO");
  if (!imu || !esc || !bat || !xkf || !baro) continue;
  const i0 = i => Number(col(imu, "I").values[i]) === 0;
  const accz = series(imu, "AccZ", i0);
  const k0 = i => Number(col(xkf, "C").values[i]) === 0;
  const vn = series(xkf, "VN", k0), ve = series(xkf, "VE", k0), vd = series(xkf, "VD", k0);
  const b0 = i => Number(col(baro, "I").values[i]) === 0;
  const press = series(baro, "Press", b0), alt = series(baro, "Alt", b0);
  const ei = col(esc, "Instance"), er = col(esc, "RPM");
  const rpm = [0, 1, 2, 3].map(k => series(esc, "RPM", i => Number(ei.values[i]) === k && Number(er.values[i]) < 100000 && Number(er.values[i]) > 3000));
  const bi = col(bat, "Inst"), bt = col(bat, "TimeUS"), bv = col(bat, "Volt"), bc = col(bat, "Curr");
  for (let i = 0; i < bat.count; i++) {
    if (bi && Number(bi.values[i]) !== 0) continue;
    const t = Number(bt.values[i]), a = t - 50000, b = t + 50000;
    const az = mean(accz, a, b), p = mean(press, a, b), h = mean(alt, a, b);
    const v = [vn, ve, vd].map(s => mean(s, t - 100000, t + 100000));
    const r = rpm.map(s => mean(s, a, b));
    if (![az, p, h, ...v, ...r].every(Number.isFinite) || v.some(x => Math.abs(x) > 1.5) || h < 1.5) continue;
    const rho = p / (287.05 * TK), n = r.map(x => x / 60);
    const s2 = n.reduce((s, x) => s + x * x, 0), s3 = n.reduce((s, x) => s + x ** 3, 0);
    // Battery power per motor = motor power (E + I R) I with E = rpm / KV (lossless ESC); shaft power E (I - I0).
    const thrust = -M * az, pe = (Number(bc.values[i]) - I_AV) * Number(bv.values[i]) / 4, RW = 0.145;
    const shaft = r.reduce((sum, x) => { const e = x / KV, ip = (-e + Math.sqrt(e * e + 4 * RW * pe)) / (2 * RW); return sum + e * (ip - I0); }, 0);
    elec.push(pe * 4);
    rows.push({ rpm: r.reduce((s, x) => s + x, 0) / 4, ct: thrust / (rho * D ** 4 * s2), cp: shaft / (rho * D ** 5 * s3), rho, volt: Number(bv.values[i]) });
  }
}
rows.sort((x, y) => x.rpm - y.rpm);
console.log(`samples ${rows.length}; m ${M} kg, avionics ${I_AV} A, I0 ${I0} A, T ${TK} K, mean density ${(rows.reduce((s, r) => s + r.rho, 0) / rows.length).toFixed(4)} kg/m3`);
const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
for (let lo = 16000; lo < 36000; lo += 2000) {
  const b = rows.filter(r => r.rpm >= lo && r.rpm < lo + 2000);
  if (b.length < 20) continue;
  console.log(`rpm ${lo}-${lo + 2000}: n ${b.length}, CT median ${med(b.map(r => r.ct)).toFixed(4)}, CP median ${med(b.map(r => r.cp)).toFixed(4)}, rpm median ${med(b.map(r => r.rpm)).toFixed(0)}`);
}
console.log(`all: CT median ${med(rows.map(r => r.ct)).toFixed(4)}, CP median ${med(rows.map(r => r.cp)).toFixed(4)}`);
console.log(`battery power to the motors: median ${med(elec).toFixed(1)} W`);
