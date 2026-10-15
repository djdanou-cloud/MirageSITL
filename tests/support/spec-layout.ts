import { readFileSync } from 'node:fs';

// Parses the binary layout tables of docs/SPECS_SHARED_MEMORY.md so tests can
// check fixtures and code against the English specification itself.

export type WireType = 'u32' | 'f32' | 'f64' | 'u64';
export interface SpecField { spec: string; offset: number; type: WireType; count: number }
export const WIDTH: Record<WireType, number> = { u32: 4, f32: 4, f64: 8, u64: 8 };

export const specText = readFileSync(new URL('../../docs/SPECS_SHARED_MEMORY.md', import.meta.url), 'utf8');

export function isWireType(value: unknown): value is WireType {
  return value === 'u32' || value === 'f32' || value === 'f64' || value === 'u64';
}

/** Expands "ideal_specific_force_x/y/z" into three labels; other cells split on " / ". */
function labels(cell: string, count: number): string[] {
  if (count === 1) return [cell];
  const spaced = cell.split(' / ');
  if (spaced.length === count) return spaced;
  const [first = '', ...suffixes] = cell.split('/');
  const width = suffixes[0]?.length ?? 0;
  if (suffixes.length === count - 1 && width > 0 && suffixes.every(suffix => suffix.length === width)) {
    const prefix = first.slice(0, first.length - width);
    return [first, ...suffixes.map(suffix => prefix + suffix)];
  }
  throw new Error(`Cannot split field labels: ${cell}`);
}

/** Parses one "### <layout> ..." byte table, in table order. */
export function specFields(layout: string, text = specText): SpecField[] {
  const start = text.indexOf(`\n${layout} `) >= 0 ? text.indexOf(`\n${layout} `) : text.indexOf(`\n${layout}\n`);
  if (start < 0) throw new Error(`Missing specification layout ${layout}`);
  const section = text.slice(start + 1).split('\n### ')[0]!.split('\n## ')[0]!;
  const fields: SpecField[] = [];
  for (const row of section.split('\n').filter(line => /^\| \d/.test(line))) {
    const [offsets = '', typeCell = '', , names = ''] = row.split('|').slice(1, -1).map(cell => cell.trim());
    const type = /^(u32|f32|f64|u64)(?:\[(\d+)\]| × (\d+)| \(lo32,hi32\))?$/.exec(typeCell);
    if (!type || !isWireType(type[1])) throw new Error(`Unknown specification type ${typeCell}`);
    const base = type[1], arrayLength = Number(type[2] ?? 1), repeated = Number(type[3] ?? 1);
    if (offsets.includes('..')) {
      const [first = NaN, last = NaN] = offsets.split('..').map(Number);
      if (last + 1 - first !== arrayLength * WIDTH[base]) throw new Error(`Inconsistent range ${offsets}`);
      fields.push({ spec: names, offset: first, type: base, count: arrayLength });
      continue;
    }
    const starts = offsets.split(' / ').map(Number), fieldLabels = labels(names, repeated);
    if (starts.length !== repeated) throw new Error(`Inconsistent row ${row}`);
    starts.forEach((offset, i) => fields.push({ spec: fieldLabels[i]!, offset, type: base, count: 1 }));
  }
  return fields;
}

/** Reads "| <name> | <offset> | <bytes> |" from the region table inside one "## " section. */
export function regionRow(section: string, name: string, text = specText): { offset: number; bytes: number } {
  const start = text.indexOf(`\n${section}`);
  if (start < 0) throw new Error(`Missing specification section ${section}`);
  const body = text.slice(start + 1).split('\n## ')[0]!;
  const row = new RegExp(`^\\| ${name} \\| ([\\d,]+) \\| ([\\d,]+) \\|`, 'm').exec(body);
  if (!row) throw new Error(`Missing region ${name} in ${section}`);
  return { offset: Number(row[1]!.replaceAll(',', '')), bytes: Number(row[2]!.replaceAll(',', '')) };
}

/** Throws unless fields cover [0, bytes) exactly once. */
export function assertCoverage(fields: readonly { offset: number; type: WireType; count: number; spec: string }[], bytes: number, what: string): void {
  const covered = new Set<number>();
  for (const field of fields) {
    for (let i = 0; i < field.count * WIDTH[field.type]; i++) {
      const byte = field.offset + i;
      if (byte >= bytes || covered.has(byte)) throw new Error(`Overlap/out of range in ${what}: ${field.spec}`);
      covered.add(byte);
    }
  }
  if (covered.size !== bytes) throw new Error(`Incomplete coverage: ${what}`);
}
