// What an acceptance run records of where it ran (TASK-158, TASK-189): the host as A-01 describes the acceptance machine, and the
// checkout's commit with every uncommitted path.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function hostFacts(root) {
  const text = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim();
  const sysctl = name => text('/usr/sbin/sysctl', ['-n', name]);
  let display = null;
  try {
    const report = JSON.parse(text('/usr/sbin/system_profiler', ['SPDisplaysDataType', '-json']));
    for (const gpu of report.SPDisplaysDataType ?? []) {
      for (const screen of gpu.spdisplays_ndrvs ?? []) {
        if (screen.spdisplays_connection_type === 'spdisplays_internal') display = { mode: screen._spdisplays_resolution ?? null, pixels: screen._spdisplays_pixels ?? null };
      }
    }
  } catch (error) {
    display = { error: error instanceof Error ? error.message : String(error) };
  }
  // Low Power Mode limits the processor, which sets the measured run speed.
  const lowPower = /lowpowermode\s+(\d)/.exec(text('/usr/bin/pmset', ['-g']))?.[1];
  return {
    platform: process.platform, arch: process.arch, model: sysctl('hw.model'), chip: sysctl('machdep.cpu.brand_string'), memoryBytes: Number(sysctl('hw.memsize')),
    macOS: { productVersion: text('/usr/bin/sw_vers', ['-productVersion']), buildVersion: text('/usr/bin/sw_vers', ['-buildVersion']) },
    node: process.version, display, lowPowerMode: lowPower === undefined ? null : lowPower === '1',
  };
}
/** The checkout's commit and every uncommitted path, files with their SHA-256, `outputs` (the run's own) left out. */
export function applicationFacts(root, outputs) {
  // Not trimmed: each line's two status columns may start with a space.
  const lines = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' }).split('\n').filter(line => line !== '');
  const uncommitted = lines.map(line => ({ status: line.slice(0, 2), path: line.slice(3) }))
    .filter(entry => !outputs.some(output => entry.path === output || entry.path.startsWith(`${output}/`)))
    .map(entry => {
      const path = join(root, entry.path);
      const file = existsSync(path) && statSync(path).isFile();
      return { ...entry, sha256: file ? sha256(readFileSync(path)) : null };
    });
  return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), uncommitted };
}
