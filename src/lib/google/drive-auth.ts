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
   *  single GIS callback slot. */
  private inFlight: Promise<string> | null = null;

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
    // Coalesce concurrent requests: GIS exposes ONE shared `callback` slot, so
    // two overlapping requestAccessToken calls (e.g. Drive autosave AND the
    // Sheets price oracle after a cold start) would overwrite each other's
    // resolver, leaving one promise hung forever. Share a single in-flight fetch.
    if (!this.inFlight) {
      this.inFlight = this.requestToken(interactive).finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async requestToken(interactive: boolean): Promise<string> {
    const client = await this.ensureClient();
    return new Promise<string>((resolve, reject) => {
      client.callback = (resp: TokenResponse) => {
        if (resp.error || !resp.access_token) {
          reject(new Error(resp.error ?? "no access token"));
          return;
        }
        this.token = resp.access_token;
        this.expiresAt = Date.now() + resp.expires_in * 1000;
        resolve(this.token);
      };
      // Empty prompt = silent reuse of prior consent; 'consent' forces the dialog.
      client.requestAccessToken({ prompt: interactive ? "consent" : "" });
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
