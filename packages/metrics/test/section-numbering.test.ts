import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * docs/03 section 0: "Section numbering is load-bearing."
 *
 * The parity parser derives section context from `## <n>.` headings, and a metric's
 * identity in the registry is (section, name) — because "Upsell Index" legitimately
 * appears in both section 4 and section 5.
 *
 * So a duplicate section number does not fail loudly. It files a metric under the
 * wrong section, and parity then reports it as a MISSING metric — sending the next
 * person to edit the registry when the actual defect is a heading in the document.
 * That is a bad hour to hand someone. This test fails first, and says so. (defect N7)
 *
 * Kept separate from registry-parity.test.ts deliberately: this is a defect in the
 * DOCUMENT's structure, and the failure message needs to say that, not "missing metric".
 */

const doc = readFileSync(
  fileURLToPath(new URL('../../../docs/03-metric-dictionary.md', import.meta.url)),
  'utf8',
);

/** `## 7. Period basis ...` -> { n: 7, title: '7. Period basis ...' }. Ignores `###`. */
function parseSectionHeadings(md: string): Array<{ n: number; title: string; line: number }> {
  const out: Array<{ n: number; title: string; line: number }> = [];
  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^##\s+(\d+)\.\s*(.*)$/.exec(lines[i] ?? '');
    if (m) out.push({ n: Number(m[1]), title: (m[2] ?? '').trim(), line: i + 1 });
  }
  return out;
}

const headings = parseSectionHeadings(doc);

describe('docs/03 section numbering', () => {
  it('finds numbered sections at all', () => {
    // Guard the guard: a regex that matched nothing would make the checks below
    // pass vacuously, which is the exact failure mode this file exists to prevent.
    expect(headings.length).toBeGreaterThanOrEqual(6);
  });

  it('has no duplicate section numbers', () => {
    const seen = new Map<number, Array<{ title: string; line: number }>>();
    for (const h of headings) {
      const list = seen.get(h.n) ?? [];
      list.push({ title: h.title, line: h.line });
      seen.set(h.n, list);
    }

    const duplicates = [...seen.entries()].filter(([, v]) => v.length > 1);
    const detail = duplicates
      .map(
        ([n, v]) =>
          `  section ${n} is used ${v.length} times:\n` +
          v.map((x) => `      docs/03-metric-dictionary.md:${x.line}  "## ${x.title}"`).join('\n'),
      )
      .join('\n');

    expect(
      duplicates.map(([n]) => n),
      `DUPLICATE SECTION NUMBER in docs/03-metric-dictionary.md.\n\n${detail}\n\n` +
        `Fix the HEADING in the document, not the registry. A metric under a duplicated\n` +
        `number is filed against the wrong section, and the parity test will report it as\n` +
        `a missing metric — which points at the wrong file. (defect N7, decision D-35)`,
    ).toEqual([]);
  });

  it('numbers sections in a contiguous ascending run', () => {
    const nums = headings.map((h) => h.n);
    const expected = Array.from({ length: nums.length }, (_, i) => (nums[0] ?? 0) + i);

    expect(
      nums,
      `SECTION NUMBERS ARE NOT SEQUENTIAL in docs/03-metric-dictionary.md.\n` +
        `  found:    ${nums.join(', ')}\n` +
        `  expected: ${expected.join(', ')}\n\n` +
        `A gap usually means a section was deleted without renumbering; an out-of-order\n` +
        `number usually means one was appended to the end of the file rather than inserted\n` +
        `in place. Renumber the headings. (decision D-35)`,
    ).toEqual(expected);
  });

  it('every section number is followed by a title', () => {
    const untitled = headings.filter((h) => h.title.length === 0);
    expect(
      untitled.map((h) => h.n),
      `Section headings must carry a title: ${untitled.map((h) => `line ${h.line}`).join(', ')}`,
    ).toEqual([]);
  });
});
