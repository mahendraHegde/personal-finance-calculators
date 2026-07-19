// Dependency-free CSV parsing (RFC 4180-ish): quoted fields, embedded commas /
// newlines / quotes (escaped as ""), and CRLF or LF line endings. Used to import
// broker / mutual-fund transaction exports entirely IN THE BROWSER — the file
// never leaves the device. Pure and unit-tested; no external library.

/** Parse CSV text into a matrix of rows × string cells. A trailing newline does
 *  not produce an empty final row; a blank line inside the file becomes a
 *  single-empty-cell row `[""]` (callers skip blanks). Never throws — malformed
 *  quoting is parsed as leniently as possible rather than rejected. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // Strip a leading UTF-8 BOM (Excel exports often include one).
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const endField = (): void => {
    row.push(field);
    field = "";
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"'; // escaped quote
          i++;
        } else {
          inQuotes = false; // closing quote
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && field === "") {
      inQuotes = true; // a quote only opens a field at its START
    } else if (c === '"') {
      field += '"'; // a stray quote mid-field is a literal — never swallow delimiters
    } else if (c === ",") {
      endField();
    } else if (c === "\n") {
      endRow();
    } else if (c === "\r") {
      // CRLF — the \n handles the row; a lone CR also ends a row.
      if (s[i + 1] === "\n") {
        endRow();
        i++;
      } else {
        endRow();
      }
    } else {
      field += c;
    }
  }
  // Flush the last field/row unless the text ended exactly on a row terminator
  // (in which case field is "" and row is empty — don't emit a phantom row).
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/** Parsed CSV as header + record objects, keyed by trimmed header names. The first
 *  non-empty row is the header. Rows with a different cell count than the header
 *  are still returned (missing cells → "", extra cells dropped) so a slightly
 *  ragged export doesn't abort the whole import. Fully-blank rows are skipped. */
export interface CsvTable {
  headers: string[];
  rows: Array<Record<string, string>>;
}

export function parseCsvTable(text: string): CsvTable {
  const matrix = parseCsv(text).filter((r) => !(r.length === 1 && r[0].trim() === ""));
  if (matrix.length === 0) return { headers: [], rows: [] };
  // Disambiguate duplicate (or trim-collided) header names — "Amount" appearing
  // twice becomes "Amount" + "Amount (2)" — so no column is silently overwritten and
  // each stays independently selectable in the mapping UI.
  const seen = new Map<string, number>();
  const headers = matrix[0].map((h) => {
    const base = h.trim();
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < matrix.length; i++) {
    const cells = matrix[i];
    const rec: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) rec[headers[c]] = (cells[c] ?? "").trim();
    rows.push(rec);
  }
  return { headers, rows };
}
