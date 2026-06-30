// Google Identity Services token flow + Drive Picker for choosing the shared
// folder. Browser-only. Uses the implicit token flow — CLIENT ID ONLY, never a
// secret (a static app can't hold one, and this flow doesn't need one). Scope is
// the minimal `drive.file`; the Picker grants access to the chosen shared folder
// (incl. files other family members created in it) without a sensitive scope.

import type { GoogleAccountsOAuth2, TokenClient, TokenResponse } from "./types";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

const GIS_SRC = "https://accounts.google.com/gsi/client";
const GAPI_SRC = "https://apis.google.com/js/api.js";

const loaded = new Set<string>();

function loadScript(src: string): Promise<void> {
  if (loaded.has(src)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.onload = () => {
      loaded.add(src);
      resolve();
    };
    el.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(el);
  });
}

/** Holds an access token and silently refreshes it when expired. */
export class GoogleAuth {
  private readonly clientId: string;
  private client: TokenClient | null = null;
  private token: string | null = null;
  private expiresAt = 0;
  /** Shared in-flight token request, so concurrent callers don't clobber the
   *  single GIS callback slot. `inFlightInteractive` records whether it will show
   *  consent — a silent in-flight request can't satisfy an interactive caller. */
  private inFlight: Promise<string> | null = null;
  private inFlightInteractive = false;

  constructor(clientId: string) {
    this.clientId = clientId;
  }

  private async ensureClient(): Promise<TokenClient> {
    if (this.client) return this.client;
    await loadScript(GIS_SRC);
    const oauth2 = window.google?.accounts?.oauth2 as GoogleAccountsOAuth2 | undefined;
    if (!oauth2) throw new Error("Google Identity Services unavailable");
    this.client = oauth2.initTokenClient({
      client_id: this.clientId,
      scope: DRIVE_SCOPE,
      callback: () => {
        /* replaced per-request below */
      },
    });
    return this.client;
  }

  /** Get a valid access token, requesting consent only when necessary. */
  async getToken(interactive = false): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - 60_000) return this.token;
    // Coalesce concurrent requests: GIS exposes ONE shared `callback` slot, so two
    // overlapping requestAccessToken calls (e.g. Drive autosave AND the Sheets
    // price oracle) would clobber each other's resolver. BUT only ride an in-flight
    // request that already satisfies the needed interactivity: a silent caller can
    // ride anything; an INTERACTIVE caller (a user Connect / 401 re-consent) must
    // NOT ride a silent request — that would never show the consent dialog and the
    // click would fail. Instead it CHAINS after the silent one settles, so the two
    // never run concurrently (callback-slot safety preserved) yet consent still
    // opens on the first click.
    if (this.inFlight && (!interactive || this.inFlightInteractive)) return this.inFlight;
    const wait = this.inFlight ? this.inFlight.catch(() => undefined) : Promise.resolve();
    const run = wait.then(() => this.requestToken(interactive));
    this.inFlight = run;
    this.inFlightInteractive = interactive;
    // Only the LATEST request clears the slot, so an orphaned silent promise that
    // settles late (via its watchdog) can't null a newer interactive request.
    void run.finally(() => {
      if (this.inFlight === run) {
        this.inFlight = null;
        this.inFlightInteractive = false;
      }
    });
    return run;
  }

  private async requestToken(interactive: boolean): Promise<string> {
    const client = await this.ensureClient();
    return new Promise<string>((resolve, reject) => {
      // Settle EXACTLY once. With prompt:"none", GIS routes a silent-auth failure
      // (interaction_required: expired session / revoked consent / ambiguous
      // multi-account) to error_callback — and may never fire the success
      // callback. Without handling that, the Promise would hang forever, pinning
      // getToken's `inFlight` so even a later interactive reconnect returns the
      // dead promise and the UI wedges. error_callback + a watchdog guarantee it
      // always settles, so a failure cleanly rejects → the caller shows a
      // reconnect state and the user's Connect click can self-heal.
      let done = false;
      // No watchdog for an interactive request — the user paces the consent dialog
      // and GIS reports cancel/closed via error_callback. Silent requests expect
      // no human, so a few seconds is ample.
      const timer = interactive
        ? null
        : setTimeout(() => {
            if (done) return;
            done = true;
            reject(new Error("silent token request timed out"));
          }, 15_000);
      const settle = (fn: () => void): void => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        fn();
      };
      client.callback = (resp: TokenResponse) => {
        settle(() => {
          if (resp.error || !resp.access_token) {
            reject(new Error(resp.error ?? "no access token"));
            return;
          }
          this.token = resp.access_token;
          this.expiresAt = Date.now() + resp.expires_in * 1000;
          resolve(this.token);
        });
      };
      client.error_callback = (err) => {
        settle(() => reject(new Error(err?.type ?? err?.message ?? "token request failed")));
      };
      // Background refresh must be SILENT. Access tokens aren't persisted across
      // page reloads, so every refresh re-requests one — and prompt:"" pops the
      // account chooser EVERY time (the reported bug). prompt:"none" issues a token
      // with NO UI when the user is signed in and has already granted access.
      // Only an explicit user action passes interactive=true → 'consent', which
      // intentionally shows the dialog once.
      client.requestAccessToken({ prompt: interactive ? "consent" : "none" });
    });
  }

  /** Drop the cached token so the NEXT getToken forces a fresh GIS fetch. Call on
   *  a 401 before retrying: getToken's cache fast-path (line above) returns the
   *  cached token regardless of the `interactive` flag, so without invalidating
   *  first, the retry would hand back the SAME dead token and could never recover
   *  until the cached clock-expiry (~1h). (A fresh requestAccessToken always
   *  issues a NEW token, so this is the only thing standing in the way.) */
  invalidate(): void {
    this.token = null;
    this.expiresAt = 0;
  }

  signOut(): void {
    this.token = null;
    this.expiresAt = 0;
  }
}

interface PickerView {
  setSelectFolderEnabled: (b: boolean) => PickerView;
  setIncludeFolders: (b: boolean) => PickerView;
  setMimeTypes: (s: string) => PickerView;
}
interface PickerInstance {
  setVisible: (v: boolean) => void;
}
interface PickerBuilder {
  addView: (v: PickerView) => PickerBuilder;
  setOAuthToken: (t: string) => PickerBuilder;
  setDeveloperKey: (k: string) => PickerBuilder;
  setTitle: (t: string) => PickerBuilder;
  setCallback: (cb: (data: { action: string; docs?: Array<{ id: string; name?: string }> }) => void) => PickerBuilder;
  build: () => PickerInstance;
}
interface PickerNs {
  PickerBuilder: new () => PickerBuilder;
  DocsView: new (viewId: unknown) => PickerView;
  ViewId: { FOLDERS: unknown };
  Action: { PICKED: string; CANCEL: string };
}

/** Show the Drive Picker restricted to folders; resolve the chosen folder. */
export async function pickFolder(
  apiKey: string,
  accessToken: string,
): Promise<{ id: string; name: string } | null> {
  await loadScript(GAPI_SRC);
  await new Promise<void>((resolve, reject) => {
    if (!window.gapi) {
      reject(new Error("gapi unavailable"));
      return;
    }
    window.gapi.load("picker", () => resolve());
  });
  const picker = (window.google as { picker?: PickerNs } | undefined)?.picker;
  if (!picker) throw new Error("Google Picker unavailable");

  return new Promise((resolve) => {
    const view = new picker.DocsView(picker.ViewId.FOLDERS)
      .setSelectFolderEnabled(true)
      .setIncludeFolders(true);
    const instance = new picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(accessToken)
      .setDeveloperKey(apiKey)
      .setTitle("Choose the shared portfolio folder")
      .setCallback((data) => {
        if (data.action === picker.Action.PICKED && data.docs?.[0]) {
          resolve({ id: data.docs[0].id, name: data.docs[0].name ?? "folder" });
        } else if (data.action === picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build();
    instance.setVisible(true);
  });
}
