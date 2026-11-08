// Logged ESC rpm against the motor's voltage balance, which does not use the pole count: rpm = KV * (V_m - I_p * R), with
// the motor voltage V_m = duty * Vbat, duty = (RCOU - 1000)/1000 for DShot (MOT_PWM_TYPE 6), and the phase current
// I_p = P / V_m from the battery power per motor P = (BAT current - avionics) * Vbat / 4 through a lossless ESC.
// KV 8000 and R 0.145 ohm are the motor listing's; the avionics current (I_AV, default 0.4 A) is assumed.
// Run: node --experimental-transform-types --no-warnings scripts/pavo/rpm-voltage-balance.mjs LOG...
import { readFileSync } from "node:fs";
const { readDataFlash } = await import("../../packages/dataflash/src/reader.ts");
const col = (g, n) => g.columns.find(c => c.name === n);
const KV = 8000, R = 0.145, I_AV = Number(process.env.I_AV ?? 0.4);
const all = [];
function series(g, tcol, vcol, filter) { const T = [], V = []; const t = col(g, tcol), v = col(g, vcol); for (let i = 0; i < g.count; i++) if (!filter || filter(i)) { T.push(Number(t.values[i])); V.push(Number(v.values[i])); } return { T, V }; }
function at(s, t) { let lo = 0, hi = s.T.length - 1; if (hi < 0) return NaN; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (s.T[m] <= t) lo = m; else hi = m - 1; } return Math.abs(s.T[lo] - t) < 60000 ? s.V[lo] : NaN; }
for (const f of process.argv.slice(2)) {
  const log = readDataFlash(new Uint8Array(readFileSync(f)));
  const esc = log.groups.find(g => g.name === "ESC"), bat = log.groups.find(g => g.name === "BAT"), rcou = log.groups.find(g => g.name === "RCOU");
  if (!esc || !bat || !rcou) continue;
  const bi = col(bat, "Inst") ?? col(bat, "Instance"), zero = i => !bi || Number(bi.values[i]) === 0;
  const volt = series(bat, "TimeUS", "Volt", zero), curr = series(bat, "TimeUS", "Curr", zero);
  const outs = [1, 2, 3, 4].map(k => series(rcou, "TimeUS", `C${k}`));
  const ei = col(esc, "Instance"), et = col(esc, "TimeUS"), er = col(esc, "RPM");
  const rows = [];
  for (let i = 0; i < esc.count; i += 5) {
    const k = Number(ei.values[i]), rpm = Number(er.values[i]), t = Number(et.values[i]);
    if (k > 3 || !Number.isFinite(rpm) || rpm < 5000 || rpm > 100000) continue;
    const vb = at(volt, t), ib = at(curr, t), pwm = at(outs[k], t);
    if (!(vb > 6 && ib >= 0 && pwm > 1050 && pwm < 2000)) continue;
    const duty = (pwm - 1000) / 1000, vm = duty * vb, ip = Math.max(0, ib - I_AV) * vb / 4 / vm, emf = vm - ip * R;
    if (emf > 0.5) rows.push([KV * emf, rpm, duty]);
  }
  if (rows.length < 100) continue;
  // slope through the origin, and its spread across duty bands
  const sxy = rows.reduce((s, r) => s + r[0] * r[1], 0), sxx = rows.reduce((s, r) => s + r[0] * r[0], 0);
  const name = f.split("/").pop().replace("stakeholder-pavo-", "").replace("_UnknownDate.bin", "");
  const band = (lo, hi) => { const b = rows.filter(r => r[2] >= lo && r[2] < hi); const m = b.map(r => r[1] / r[0]).sort((a, c) => a - c); return b.length > 30 ? `${m[m.length >> 1].toFixed(3)}(n=${b.length})` : "-"; };
  console.log(name, "n", rows.length, "slope logged/predicted", (sxy / sxx).toFixed(3), "median by duty 0.1-0.2:", band(0.1, 0.2), "0.2-0.3:", band(0.2, 0.3), "0.3-0.5:", band(0.3, 0.5), "0.5+:", band(0.5, 1));
  all.push(...rows);
}
const m = all.map(r => r[1] / r[0]).sort((a, b) => a - b);
console.log("all: n", all.length, "median logged/predicted", m[m.length >> 1].toFixed(3), "p10", m[Math.floor(m.length * 0.1)].toFixed(3), "p90", m[Math.floor(m.length * 0.9)].toFixed(3));
