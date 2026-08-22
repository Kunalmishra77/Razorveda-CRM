/**
 * Upload content validation (Phase 5 deliverable 7).
 *
 * The ingestion path takes base64 and treats it as CSV text. Three things can go
 * wrong before a single row is parsed, and all three used to produce confusing
 * failures deep inside the mapper rather than a clear refusal at the door.
 *
 *   1. It is not text at all. An XLSX is a ZIP; read as UTF-8 it becomes
 *      thousands of replacement characters and the column-shift detector rejects
 *      it with a message about type contracts, which tells the admin nothing.
 *   2. It is too big. Guarded by the body limit, but that produces a bare 413
 *      with no explanation of what to do.
 *   3. It is text but not delimited — a PDF export, a Word document saved as
 *      .csv, a log file someone grabbed by mistake.
 *
 * Every refusal here says what the file appears to be and what to do about it.
 */

/**
 * 2,000 rows/day at ~175 bytes a row is ~350 KB, and base64 adds a third. The
 * historical backfill is far larger, so the ceiling is set for that rather than
 * for a normal day — with the whole file held in memory, which is why it is a
 * ceiling and not simply absent.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export type UploadVerdict =
  | { readonly ok: true; readonly bytes: number }
  | { readonly ok: false; readonly reason: string };

/** File signatures worth naming, because the admin will recognise the format. */
const SIGNATURES: ReadonlyArray<readonly [readonly number[], string, string]> = [
  [[0x50, 0x4b, 0x03, 0x04], 'an Excel workbook (.xlsx) or a zip file',
   'Open it in Excel and use File → Save As → CSV UTF-8, then upload that.'],
  [[0xd0, 0xcf, 0x11, 0xe0], 'an old-format Excel workbook (.xls)',
   'Open it in Excel and use File → Save As → CSV UTF-8, then upload that.'],
  [[0x25, 0x50, 0x44, 0x46], 'a PDF',
   'A PDF cannot be imported. Export the data from its original system as CSV.'],
  [[0x1f, 0x8b], 'a gzip archive',
   'Extract it first and upload the CSV inside.'],
];

export function validateUpload(bytes: Uint8Array, fileName: string): UploadVerdict {
  if (bytes.length === 0) {
    return { ok: false, reason: `"${fileName}" is empty. Check the export and try again.` };
  }

  if (bytes.length > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      reason:
        `"${fileName}" is ${(bytes.length / 1024 / 1024).toFixed(1)} MB, over the ` +
        `${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit. Split it by date range and upload the parts — ` +
        `each batch is committed and rolled back independently, so several files are no harder ` +
        `to manage than one.`,
    };
  }

  for (const [signature, description, advice] of SIGNATURES) {
    if (signature.every((b, i) => bytes[i] === b)) {
      return { ok: false, reason: `"${fileName}" looks like ${description}. ${advice}` };
    }
  }

  // A NUL byte in the first kilobyte means binary. Text files do not contain them,
  // and a UTF-16 export does — which is worth catching, because Excel produces
  // UTF-16 .txt exports that look fine in Notepad.
  const head = bytes.subarray(0, 1024);
  if (head.includes(0)) {
    return {
      ok: false,
      reason:
        `"${fileName}" contains binary data, so it is not a plain CSV. If it was exported as ` +
        `"Unicode Text" or "UTF-16", re-export it as CSV UTF-8.`,
    };
  }

  const text = Buffer.from(bytes.subarray(0, 4096)).toString('utf8');
  const firstLine = text.split(/\r?\n/)[0] ?? '';

  if (!firstLine.includes(',') && !firstLine.includes('\t') && !firstLine.includes(';')) {
    return {
      ok: false,
      reason:
        `The first line of "${fileName}" has no commas, tabs or semicolons, so it does not ` +
        `look like a delimited file. Its first line is: "${firstLine.slice(0, 80)}". ` +
        `Check you exported the sheet rather than a report or a document.`,
    };
  }

  return { ok: true, bytes: bytes.length };
}
