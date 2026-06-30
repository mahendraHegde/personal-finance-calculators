// Minimal typings for the Google Identity Services + Picker globals we use,
// so we avoid pulling in @types packages and keep eslint happy (no `any`).

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  error?: string;
}

/** GIS routes interaction-required / popup failures to error_callback (NOT the
 *  success callback), so prompt:"none" silent failures must be handled here or
 *  the token request hangs forever. */
export interface TokenError {
  type?: string;
  message?: string;
}

export interface TokenClient {
  callback: (resp: TokenResponse) => void;
  error_callback?: (err: TokenError) => void;
  requestAccessToken: (opts?: { prompt?: string }) => void;
}

export interface GoogleAccountsOAuth2 {
  initTokenClient: (config: {
    client_id: string;
    scope: string;
    callback: (resp: TokenResponse) => void;
  }) => TokenClient;
}

export interface PickerDocument {
  id: string;
  name?: string;
  mimeType?: string;
}

export interface PickerResponse {
  action: string;
  docs?: PickerDocument[];
}

declare global {
  interface Window {
    google?: {
      accounts?: { oauth2?: GoogleAccountsOAuth2 };
      picker?: unknown;
    };
    gapi?: {
      load: (name: string, cb: () => void) => void;
    };
  }
}

export {};
