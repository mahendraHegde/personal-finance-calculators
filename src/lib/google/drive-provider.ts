// SyncProvider backed by the Google Drive REST API (v3). Browser-only.
// Snapshots are files in one shared folder; metadata lives in `appProperties`
// so listing is cheap (no bodies downloaded) and "latest" is read from there.

import type { SnapshotMeta, SyncProvider } from "../sync/types";
import type { GoogleAuth } from "./drive-auth";
import { SignInRequiredError } from "./drive-auth";

const FILES = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

// Tag every snapshot with this appProperty and query by it (not by filename) —
// a user/Drive-app rename of a file must not hide it from "latest" detection.
const APP_TAG_KEY = "pfApp";
const APP_TAG_VALUE = "portfolio";

interface DriveFile {
  id: string;
  name: string;
  appProperties?: Record<string, string>;
}

function metaToProps(meta: Omit<SnapshotMeta, "id" | "name"> | Partial<SnapshotMeta>): Record<string, string> {
  const p: Record<string, string> = {};
  if (meta.version !== undefined) p.version = String(meta.version);
  if (meta.author !== undefined) p.author = meta.author;
  if (meta.deviceId !== undefined) p.deviceId = meta.deviceId;
  if (meta.savedAt !== undefined) p.savedAt = meta.savedAt;
  if (meta.schemaVersion !== undefined) p.schemaVersion = String(meta.schemaVersion);
  return p;
}

/** Coerce an untrusted numeric appProperty to a finite number (default 0). A
 *  non-numeric value (manual Drive edit, older/newer build, partial write) would
 *  otherwise become NaN and poison version math — NaN disables the pull-before-
 *  push guard (`NaN > x` is false), wedges `dirty` forever (`NaN !== NaN`), and
 *  gets written back to Drive as the string "NaN", corrupting it for everyone. */
function finiteNum(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fileToMeta(f: DriveFile): SnapshotMeta {
  const p = f.appProperties ?? {};
  return {
    id: f.id,
    name: f.name,
    version: finiteNum(p.version),
    author: p.author ?? "",
    // An untagged snapshot (manual upload, older/future build, edited
    // appProperties) gets a unique per-file sentinel — never "". This guarantees
    // it sorts as FOREIGN in the sync guard (a blank id could otherwise collapse
    // into "own history" and skip the pull-before-push overwrite check).
    deviceId: p.deviceId || `__untagged:${f.id}`,
    savedAt: p.savedAt ?? "",
    schemaVersion: finiteNum(p.schemaVersion),
  };
}

export class DriveSyncProvider implements SyncProvider {
  private readonly auth: GoogleAuth;
  private readonly folderId: string;

  constructor(auth: GoogleAuth, folderId: string) {
    this.auth = auth;
    this.folderId = folderId;
  }

  private async req(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.auth.getToken();
    const res = await fetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      // Token revoked/expired server-side. Drop it and fail — do NOT open a popup
      // in the background (that's the every-refresh-chooser bug + Windows popup
      // failures). The user reconnects explicitly (Settings → Reconnect Google).
      this.auth.invalidate();
      throw new SignInRequiredError("Google sign-in expired — reconnect in Settings");
    }
    return res;
  }

  async list(): Promise<SnapshotMeta[]> {
    const q = encodeURIComponent(
      `'${this.folderId}' in parents and ` +
        `appProperties has { key='${APP_TAG_KEY}' and value='${APP_TAG_VALUE}' } and ` +
        `trashed = false`,
    );
    // Page through ALL results — over years a folder can exceed one page, and
    // missing later pages would hide the newest snapshot.
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const tok = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
      const url = `${FILES}?q=${q}&fields=nextPageToken,files(id,name,appProperties)&pageSize=1000${tok}`;
      const res = await this.req(url);
      if (!res.ok) throw new Error(`Drive list failed: ${res.status}`);
      const body = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
      files.push(...(body.files ?? []));
      pageToken = body.nextPageToken;
    } while (pageToken);
    return files.map(fileToMeta);
  }

  async download(id: string): Promise<Uint8Array> {
    const res = await this.req(`${FILES}/${id}?alt=media`);
    if (!res.ok) throw new Error(`Drive download failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  private multipart(metadata: object, data: Uint8Array): { body: Blob; boundary: string } {
    // Random boundary so it can't collide with the (encrypted) body bytes.
    const boundary = `pfdb-${crypto.randomUUID()}`;
    const head =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const tail = `\r\n--${boundary}--`;
    return {
      body: new Blob([head, data, tail]),
      boundary,
    };
  }

  async create(meta: Omit<SnapshotMeta, "id">, data: Uint8Array): Promise<SnapshotMeta> {
    const metadata = {
      name: meta.name,
      parents: [this.folderId],
      // Include the app tag so list() finds it by property, not by filename.
      appProperties: { ...metaToProps(meta), [APP_TAG_KEY]: APP_TAG_VALUE },
    };
    const { body, boundary } = this.multipart(metadata, data);
    const res = await this.req(`${UPLOAD}?uploadType=multipart&fields=id,name,appProperties`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!res.ok) throw new Error(`Drive create failed: ${res.status}`);
    return fileToMeta((await res.json()) as DriveFile);
  }

  async update(id: string, meta: Partial<SnapshotMeta>, data: Uint8Array): Promise<void> {
    const metadata = { appProperties: metaToProps(meta) };
    const { body, boundary } = this.multipart(metadata, data);
    const res = await this.req(`${UPLOAD}/${id}?uploadType=multipart`, {
      method: "PATCH",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!res.ok) throw new Error(`Drive update failed: ${res.status}`);
  }

  async remove(id: string): Promise<void> {
    // 404 = already gone (another device pruned it) → treat as success.
    const res = await this.req(`${FILES}/${id}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error(`Drive delete failed: ${res.status}`);
  }
}
