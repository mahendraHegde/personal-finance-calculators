// GOOGLEFINANCE price oracle, backed by the user's own Google Sheet. Browser-only.
//
// Google shut its Finance API down years ago, but the GOOGLEFINANCE() worksheet
// function still works for US + global equities/ETFs (e.g. "VOO", "NSE:INFY")
// and Indian mutual funds ("MUTF_IN:..."). Since this is a static, key-less app,
// we can't call a quote API server-side — so we drive a Sheet the user already
// authorises (same Drive OAuth as sync, scope `drive.file`, which the Sheets API
// honours for app-created files): write `=GOOGLEFINANCE(...)` formulas, let
// Google recalc, then read the values back. The sheet is a per-device scratch
// oracle (its id lives in device-local settings), NOT portfolio data.
//
// Requires the Google Sheets API to be enabled in the same Cloud project as the
// OAuth client id. `parseSheetQuotes` is pure so it's unit-testable without a
// network or a real Sheet.

import type { GoogleAuth } from "./drive-auth";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

export interface OracleQuote {
  ticker: string;
  price: number;
  /** Currency GOOGLEFINANCE reports; "" when unavailable (caller assumes the
   *  holding's own currency). */
  currency: string;
}

/** Pure: map the Sheet's value grid (row i = [ticker, price, currency], in the
 *  order we wrote the tickers) into quotes. Rows whose price isn't a positive
 *  finite number (GOOGLEFINANCE error / "Loading…" / blank) are dropped. */
export function parseSheetQuotes(rows: unknown[][], tickers: string[]): OracleQuote[] {
  const out: OracleQuote[] = [];
  for (let i = 0; i < tickers.length; i++) {
    const row = rows[i] ?? [];
    const rawPrice = row[1];
    const price = typeof rawPrice === "number" ? rawPrice : Number(rawPrice);
    if (!Number.isFinite(price) || price <= 0) continue;
    const rawCcy = row[2];
    const currency = typeof rawCcy === "string" ? rawCcy.trim().toUpperCase() : "";
    out.push({ ticker: tickers[i], price, currency });
  }
  return out;
}

/** True while any price cell still shows GOOGLEFINANCE's transient "Loading…". */
function stillLoading(rows: unknown[][]): boolean {
  return rows.some((row) => row?.some((c) => typeof c === "string" && /loading/i.test(c)));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface OracleSheetStore {
  getSheetId: () => string | undefined;
  setSheetId: (id: string) => Promise<void>;
}

export class SheetsOracle {
  private readonly auth: GoogleAuth;
  private readonly store: OracleSheetStore;
  /** Coalesces concurrent first-time creates so two quotes don't each mint a
   *  scratch sheet (which would orphan one in the user's Drive). */
  private creating: Promise<string> | null = null;

  constructor(auth: GoogleAuth, store: OracleSheetStore) {
    this.auth = auth;
    this.store = store;
  }

  private ensureSheet(): Promise<string> {
    const existing = this.store.getSheetId();
    if (existing) return Promise.resolve(existing);
    if (!this.creating) {
      this.creating = this.createSheet().finally(() => {
        this.creating = null;
      });
    }
    return this.creating;
  }

  private async req(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.auth.getToken();
    const headers = { ...(init.headers ?? {}), Authorization: `Bearer ${token}` };
    const res = await fetch(url, { ...init, headers });
    if (res.status === 401) {
      // Drop the dead cached token first, else getToken returns it again.
      this.auth.invalidate();
      const fresh = await this.auth.getToken(true);
      return fetch(url, { ...init, headers: { ...headers, Authorization: `Bearer ${fresh}` } });
    }
    return res;
  }

  private async createSheet(): Promise<string> {
    const res = await this.req(SHEETS_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ properties: { title: "Portfolio price oracle (auto)" } }),
    });
    if (!res.ok) {
      throw new Error(
        `Couldn't create the price sheet (${res.status}). Enable the Google Sheets API in the same Cloud project as your client id.`,
      );
    }
    const body = (await res.json()) as { spreadsheetId?: string };
    if (!body.spreadsheetId) throw new Error("Sheets create returned no id");
    await this.store.setSheetId(body.spreadsheetId);
    return body.spreadsheetId;
  }

  private async writeFormulas(sheetId: string, tickers: string[]): Promise<Response> {
    const values = tickers.map((t) => {
      const safe = t.replace(/"/g, '""'); // escape quotes inside the formula string
      return [
        t,
        `=IFERROR(GOOGLEFINANCE("${safe}"),"")`,
        `=IFERROR(GOOGLEFINANCE("${safe}","currency"),"")`,
      ];
    });
    return this.req(
      `${SHEETS_API}/${sheetId}/values/A1:C${tickers.length}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values }),
      },
    );
  }

  private async readValues(sheetId: string, rowCount: number): Promise<unknown[][]> {
    const res = await this.req(
      `${SHEETS_API}/${sheetId}/values/A1:C${rowCount}?valueRenderOption=UNFORMATTED_VALUE`,
    );
    if (!res.ok) throw new Error(`Sheets read failed: ${res.status}`);
    const body = (await res.json()) as { values?: unknown[][] };
    return body.values ?? [];
  }

  /** Quote a batch of GOOGLEFINANCE tickers (equities, ETFs, MFs). */
  async quote(tickers: string[]): Promise<OracleQuote[]> {
    const unique = [...new Set(tickers.map((t) => t.trim()).filter(Boolean))];
    if (unique.length === 0) return [];

    let sheetId = await this.ensureSheet();
    let write = await this.writeFormulas(sheetId, unique);
    if (write.status === 404) {
      // Stored sheet was deleted/inaccessible — make a fresh one and retry once.
      sheetId = await this.createSheet();
      write = await this.writeFormulas(sheetId, unique);
    }
    if (!write.ok) throw new Error(`Sheets write failed: ${write.status}`);

    // GOOGLEFINANCE recalculates asynchronously; poll until no cell is "Loading…".
    let rows: unknown[][] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      rows = await this.readValues(sheetId, unique.length);
      if (!stillLoading(rows)) break;
      await delay(800);
    }
    return parseSheetQuotes(rows, unique);
  }
}
