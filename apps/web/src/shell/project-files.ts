import { ARCHIVE_FILE_EXTENSION } from '@mirage/project/archive';
import { ProjectStoreError } from '@mirage/project/schema';

// Project archive file names and plain explanations of project-store errors
// for the Project tab (TASK-137).

/** File names are cut to this many UTF-8 bytes before the extension; macOS allows 255. */
const MAX_FILE_NAME_BYTES = 120;
// Controls, format characters (including bidirectional ones) and characters that file systems reserve.
const RESERVED = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}/\\:*?"<>|]+/gu;

/** A download file name for a project archive: the project name without reserved characters. */
export function archiveFileName(projectName: string): string {
  const cleaned = projectName.normalize('NFC').replace(RESERVED, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  const encoder = new TextEncoder();
  let base = '', bytes = 0;
  for (const character of cleaned) {
    bytes += encoder.encode(character).byteLength;
    if (bytes > MAX_FILE_NAME_BYTES) break;
    base += character;
  }
  base = base.trim();
  return `${base === '' ? 'project' : base}${ARCHIVE_FILE_EXTENSION}`;
}

export type ProjectOperation = 'create' | 'rename' | 'open' | 'export' | 'import' | 'storage';

/** A plain explanation of a failed project operation. */
export function describeProjectError(error: unknown, operation: ProjectOperation): string {
  if (!(error instanceof ProjectStoreError)) return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
  switch (error.code) {
    case 'invalid':
      return `The input was refused: ${error.message}.`;
    case 'not-found':
      return 'The project or record is no longer stored.';
    case 'conflict':
      return operation === 'import'
        ? 'This project was changed both here and in the archive, so nothing was imported.'
        : 'The project changed elsewhere, for example in another tab. Reopen it and try again.';
    case 'missing-dependency':
      return `A record that this project needs is missing: ${error.message}.`;
    case 'quota-exceeded':
      return 'The browser storage quota for MirageSITL is exhausted. Export projects to files and free browser storage.';
    case 'storage':
      return `Local project storage failed: ${error.message}.`;
    case 'archive-size':
      return 'The file is empty or larger than the 128 MiB project archive limit.';
    case 'archive-header':
      return 'The file is not a MirageSITL project archive.';
    case 'archive-hash':
      return 'The file is damaged or was changed: its checksum does not match. Nothing was imported.';
    case 'archive-invalid':
      return `The archive content is invalid, so nothing was imported: ${error.message}.`;
  }
}

/** The language of a user-defined name for screen readers: Russian when it contains Cyrillic letters. */
export function nameLanguage(name: string): 'ru' | undefined {
  return /\p{Script=Cyrillic}/u.test(name) ? 'ru' : undefined;
}
