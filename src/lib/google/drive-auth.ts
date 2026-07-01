// Google Identity Services token flow + Drive Picker for choosing the shared
// folder. Browser-only. Uses the implicit token flow — CLIENT ID ONLY, never a
// secret (a static app can't hold one, and this flow doesn't need one). Scope is
// the minimal `drive.file`; the Picker grants access to the chosen shared folder
// (incl. files other family members created in it) without a sensitive scope.

import type { GoogleAccountsOAuth2, TokenClient, TokenResponse } from "./types";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

/** Thrown when a usable token can't be obtained WITHOUT opening a popup (no valid
 *  stored token in the background, or a 401). Callers use it to surface a
 *  "Reconnect" prompt and to NOT auto-retry — retrying can't succeed without the
 *  user, and would just churn. */
export class SignInRequiredError extends Error {
  constructor(message = "Google sign-in required") {
    super(message);
    this.name = "SignInRequiredError";
  }
}

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

/** Holds a Google access token, PERSISTED across reloads (localStorage) so a page
 *  refresh reuses the still-valid token instead of re-prompting. The GIS token
 *  flow is POPUP-based — a fresh token can only come from a popup — so we open one
 *  ONLY on an explicit user action (interactive=true). Background callers reuse the
 *  stored token or fail (never a popup), which is what stops the account chooser
 *  appearing on every refresh and trips of popup_closed / COOP errors on the
 *  browsers (notably Windows Chrome) where the silent popup flow misbehaves. */
export class GoogleAuth {
  private readonly clientId: string;
  private readonly storeKey: string;
  private client: TokenClient | null = null;
  private token: string | null = null;
  private expiresAt = 0;
  /** One shared in-flight INTERACTIVE request, so concurrent Connect/Reconnect
   *  clicks open a SINGLE popup instead of clobbering GIS's one callback slot. */
  private inFlight: Promise<string> | null = null;

  constructor(clientId: string) {
    this.clientId = clientId;
    this.storeKey = `pf-gtoken-${clientId}`;
    this.load();
  }

  private valid(): boolean {
    return this.token !== null && Date.now() < this.expiresAt - 60_000;
  }

  // Persist the (user's own, ~1h-lived) token so a reload reuses it without a popup.
  private save(): void {
    try {
      localStorage.setItem(this.storeKey, JSON.stringify({ token: this.token, expiresAt: this.expiresAt }));
    } catch {
      /* private mode / quota — fall back to in-memory only */
    }
  }
  private load(): void {
    try {
      const raw = localStorage.getItem(this.storeKey);
      if (!raw) return;
      const v = JSON.parse(raw) as { token?: unknown; expiresAt?: unknown };
      if (typeof v.token === "string" && typeof v.expiresAt === "number") {
        this.token = v.token;
        this.expiresAt = v.expiresAt;
      }
    } catch {
      /* ignore a corrupt entry */
    }
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

  /**
   * A valid access token. `interactive=false` (background: autosave, price refresh)
   * NEVER opens a popup — it returns the stored token or THROWS, so the UI can show
   * a "reconnect" prompt. Only `interactive=true` (an explicit Connect / Reconnect
   * click) opens the GIS popup. This is what keeps the chooser off every refresh.
   */
  async getToken(interactive = false): Promise<string> {
    if (this.valid()) return this.token as string;
    if (!interactive) throw new SignInRequiredError();
    // Coalesce concurrent interactive requests onto ONE popup (GIS has a single
    // shared callback slot). The rejection is handled both here (so it never
    // surfaces as an unhandled rejection) and by the awaiting caller.
    if (!this.inFlight) {
      const req = this.requestToken();
      this.inFlight = req;
      void req.then(
        () => {
          this.inFlight = null;
        },
        () => {
          this.inFlight = null;
        },
      );
    }
    return this.inFlight;
  }

  private async requestToken(): Promise<string> {
    const client = await this.ensureClient();
    return new Promise<string>((resolve, reject) => {
      // Settle exactly once. error_callback handles the popup cancel/closed/blocked
      // cases; the watchdog is a generous backstop so a hung popup can't wedge the
      // Connect button forever (the user paces the dialog).
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error("sign-in timed out"));
      }, 120_000);
      const settle = (fn: () => void): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn();
      };
      client.callback = (resp: TokenResponse) =>
        settle(() => {
          if (resp.error || !resp.access_token) {
            reject(new Error(resp.error ?? "no access token"));
            return;
          }
          this.token = resp.access_token;
          this.expiresAt = Date.now() + resp.expires_in * 1000;
          this.save();
          resolve(this.token);
        });
      client.error_callback = (err) =>
        settle(() => reject(new Error(err?.type ?? err?.message ?? "sign-in failed")));
      // Empty prompt reuses prior consent when possible (quick re-auth) and shows
      // the chooser/consent the first time. Reached only via an explicit user
      // action, so a popup here is expected.
      client.requestAccessToken({ prompt: "" });
    });
  }

  /** Forget the token (e.g. after a 401) so the next INTERACTIVE request re-auths.
   *  Never opens a popup — background callers reject and the UI prompts to reconnect. */
  invalidate(): void {
    this.token = null;
    this.expiresAt = 0;
    try {
      localStorage.removeItem(this.storeKey);
    } catch {
      /* ignore */
    }
  }

  signOut(): void {
    this.invalidate();
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
