// SyncProvider backed by the Google Drive REST API (v3). Browser-only.
// Snapshots are files in one shared folder; metadata lives in `appProperties`
// so listing is cheap (no bodies downloaded) and "latest" is read from there.

import type { SnapshotMeta, SyncProvider } from "../sync/types";
import { compareKeyringNewestFirst } from "../crypto/keyring";
import type { GoogleAuth } from "./drive-auth";
import { SignInRequiredError } from "./drive-auth";

const FILES = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

// Tag every snapshot with this appProperty and query by it (not by filename) —
// a user/Drive-app rename of a file must not hide it from "latest" detection.
const APP_TAG_KEY = "pfApp";
const APP_TAG_VALUE = "portfolio";
// The keyring files (envelope encryption) live in the SAME folder but under a
// distinct tag so the snapshot query never returns them, and vice versa.
const KEYRING_TAG_VALUE = "portfolio-keyring";

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

  /** Page through ALL files in the folder carrying the given app tag — over years
   *  a folder can exceed one page, and missing later pages would hide the newest
   *  file. Shared by snapshot listing and keyring listing. */
  private async queryFiles(tagValue: string): Promise<DriveFile[]> {
    const q = encodeURIComponent(
      `'${this.folderId}' in parents and ` +
        `appProperties has { key='${APP_TAG_KEY}' and value='${tagValue}' } and ` +
        `trashed = false`,
    );
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
    return files;
  }

  async list(): Promise<SnapshotMeta[]> {
    return (await this.queryFiles(APP_TAG_VALUE)).map(fileToMeta);
  }

  // -- keyring (envelope encryption) ---------------------------------------
  // The folder's shared keyring is stored as its own immutable, versioned files
  // (tag KEYRING_TAG_VALUE). Latest = max version, same as snapshots. Deterministic
  // id tiebreak so every device agrees on the winner when two share a version.

  /** Cheap listing of keyring files (id + version only). */
  async listKeyrings(): Promise<{ id: string; version: number; dekId?: string }[]> {
    return (await this.queryFiles(KEYRING_TAG_VALUE)).map((f) => ({
      id: f.id,
      version: finiteNum(f.appProperties?.version),
      // Non-secret DEK identity mirrored into appProperties so a device can detect a
      // concurrent DEK ROTATION (a reset) from the cheap listing, without downloading
      // every keyring body. Untrusted metadata → used ONLY as a conservative signal
      // (triggers a safe drop + re-unlock), never as the sole basis for adoption.
      dekId: f.appProperties?.dekId,
    }));
  }

  /** Create a NEW keyring file at `version` (immutable — never overwrite an
   *  existing one; latest-wins by version like snapshots). `dekId` is mirrored into
   *  appProperties for cheap concurrent-rotation detection (see listKeyrings). */
  async putKeyring(
    version: number,
    dekId: string,
    data: Uint8Array,
  ): Promise<{ id: string; version: number }> {
    const metadata = {
      name: `pf-keyring-${version}.pfkeyring`,
      parents: [this.folderId],
      appProperties: { [APP_TAG_KEY]: KEYRING_TAG_VALUE, version: String(version), dekId },
    };
    const { body, boundary } = this.multipart(metadata, data);
    const res = await this.req(`${UPLOAD}?uploadType=multipart&fields=id,appProperties`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!res.ok) throw new Error(`Drive keyring create failed: ${res.status}`);
    const f = (await res.json()) as DriveFile;
    return { id: f.id, version: finiteNum(f.appProperties?.version) };
  }

  /** Keep the `keep` highest-version keyrings, delete the rest. Safe for ANY
   *  device to run: an older keyring is strictly superseded (it wraps the SAME
   *  invariant DEK under an older-or-equal passphrase), so deleting it never loses
   *  data — unlike snapshots, which can hold unmerged foreign edits. Best effort. */
  async pruneKeyrings(keep: number): Promise<void> {
    const metas = await this.listKeyrings();
    if (metas.length <= keep) return;
    const sorted = [...metas].sort(compareKeyringNewestFirst);
    for (const m of sorted.slice(keep)) {
      try {
        await this.remove(m.id);
      } catch {
        // transient delete failure — a later prune retries
      }
    }
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
