import { inflateRawSync } from 'node:zlib';

// The cells of an .xlsx workbook's first sheet as text rows (TASK-101, NASA MTB2 tables). An .xlsx file is a zip of XML parts:
// the central directory names each part, the shared-strings part holds the text cells and the worksheet part the rest. Only
// what those workbooks use is read: stored or deflated parts, shared, inline and numeric cells. Test support; Node only.

const END_OF_DIRECTORY = 0x06054b50, DIRECTORY_ENTRY = 0x02014b50, LOCAL_HEADER = 0x04034b50;

function zipParts(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), parts = new Map<string, Uint8Array>();
  let end = -1;
  for (let at = bytes.byteLength - 22; at >= Math.max(0, bytes.byteLength - 22 - 65535); at--) {
    if (view.getUint32(at, true) === END_OF_DIRECTORY) { end = at; break; }
  }
  if (end < 0) throw new Error('Not a zip archive: no end of central directory');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== DIRECTORY_ENTRY) throw new Error('Damaged zip central directory');
    const method = view.getUint16(at + 10, true), size = view.getUint32(at + 20, true), expanded = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true), extraLength = view.getUint16(at + 30, true), commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true), name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (view.getUint32(local, true) !== LOCAL_HEADER) throw new Error(`Damaged zip entry ${name}`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true), raw = bytes.subarray(start, start + size);
    let data: Uint8Array;
    if (method === 0) data = raw;
    else if (method === 8) data = new Uint8Array(inflateRawSync(raw));
    else throw new Error(`Zip entry ${name} uses compression method ${method}`);
    if (data.byteLength !== expanded) throw new Error(`Zip entry ${name} expands to ${data.byteLength} bytes, not ${expanded}`);
    parts.set(name, data);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return parts;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, name: string) => {
    if (name.startsWith('#x')) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(parseInt(name.slice(1), 10));
    return ENTITIES[name] ?? whole;
  });
}
/** The text of every <t> inside a fragment, joined (rich-text runs split a cell's text). */
function textOf(fragment: string): string {
  let out = '';
  for (const match of fragment.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)) out += unescapeXml(match[1] ?? '');
  return out;
}
function columnIndex(reference: string): number {
  const letters = /^[A-Z]+/.exec(reference)?.[0];
  if (!letters) throw new Error(`Invalid cell reference ${reference}`);
  let n = 0;
  for (const letter of letters) n = n * 26 + letter.charCodeAt(0) - 64;
  return n - 1;
}

/** Every row of the first sheet, each cell's text in its column ('' where a row has no cell). */
export function readFirstSheet(bytes: Uint8Array): string[][] {
  const parts = zipParts(bytes), xml = (name: string): string => {
    const part = parts.get(name);
    if (!part) throw new Error(`The workbook has no ${name}`);
    return new TextDecoder().decode(part);
  };
  const shared = parts.has('xl/sharedStrings.xml') ? [...xml('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => textOf(m[1] ?? '')) : [];
  const firstSheet = /<sheet\s[^>]*r:id="([^"]+)"/.exec(xml('xl/workbook.xml'))?.[1];
  if (!firstSheet) throw new Error('The workbook lists no sheet');
  const relation = [...xml('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\s([^>]*)\/?>/g)].map(m => m[1] ?? '')
    .find(attributes => attributes.includes(`Id="${firstSheet}"`));
  const target = relation ? /Target="([^"]+)"/.exec(relation)?.[1] : undefined;
  if (!target) throw new Error(`The workbook has no part for sheet ${firstSheet}`);
  const sheet = xml(target.startsWith('/') ? target.slice(1) : `xl/${target}`), rows: string[][] = [];
  for (const row of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cell of (row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cell[1] ?? '', body = cell[2] ?? '', reference = /\br="([A-Z]+[0-9]+)"/.exec(attributes)?.[1];
      if (!reference) throw new Error('A cell without a reference');
      const type = /\bt="([a-zA-Z]+)"/.exec(attributes)?.[1], value = /<v>([^<]*)<\/v>/.exec(body)?.[1];
      let text = '';
      if (type === 'inlineStr') text = textOf(body);
      else if (value !== undefined && type === 's') {
        const item = shared[Number(value)];
        if (item === undefined) throw new Error(`Cell ${reference} names shared string ${value}, beyond the table`);
        text = item;
      } else if (value !== undefined) text = unescapeXml(value);
      const column = columnIndex(reference);
      while (cells.length < column) cells.push('');
      cells[column] = text;
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}
