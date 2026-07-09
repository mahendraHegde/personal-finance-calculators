# Migration history

A running log of **data-format / crypto migrations** — what changed, why, and how a
device (or the shared Drive folder) moves from the old shape to the new one without
losing data or locking out other devices.

Each entry documents: the trigger, the old vs new format, the migration path, backward
compatibility, and the honest limits. Read this before touching `src/lib/crypto/*` or
the vault/keyring code in `sync-controller.ts`.

---

## 2026-07 — Envelope encryption for the vault (`pfdb-v1` → `pfdb-v2` + keyring)

### Why

The original design derived the file-encryption key **directly** from the passphrase:
`key = PBKDF2(passphrase, salt)`, and that key encrypted every snapshot and backup
(`pfdb-v1`). This has two fatal properties for a **shared folder used by multiple
devices/people**:

1. **Password change is destructive.** A different passphrase → a different key. Every
   file written under the old key becomes permanently unreadable with the new one. There
   is no way to "re-key" an already-written file short of decrypting and rewriting it.
2. **A password change breaks the shared folder for everyone.** If one device re-derived
   its key and started writing snapshots under it, the other devices (still on the old
   passphrase) could not read the new snapshots, and the re-keying device could not read
   the folder's existing ones. The folder splits into two mutually unreadable halves.

The user's explicit requirements were: **(a)** be able to *change* the password and keep
old backups/snapshots decryptable, **(b)** be able to *reset* a forgotten password, and
**(c)** never break a folder shared by several devices — all under a **single shared
password**.

Direct key derivation cannot satisfy these. Envelope encryption can.

### The idea (envelope encryption)

Split the one key into **two keys with different jobs**:

- **DEK — Data Encryption Key.** A *random* 256-bit AES-GCM key. It actually encrypts the
  snapshots/backups. It is generated **once per folder** and **never changes**.
- **KEK — Key Encryption Key.** Derived from the passphrase exactly as before
  (`PBKDF2-SHA-256, 600k iters, 16-byte salt`). Its *only* job is to **wrap** (encrypt)
  the DEK.

The passphrase no longer touches the files. It only guards the DEK. "Wrapping" = encrypting
one key's bytes with another key (plain AES-GCM over the raw DEK bytes — we do **not** use
`crypto.subtle.wrapKey`; we treat the DEK as data and `encryptBytes` it with the KEK).

Because the DEK is stable:

- **Change / reset password** = derive a new KEK from the new passphrase and **re-wrap the
  same DEK**. The DEK — and therefore every file ever written with it — is unchanged, so
  **all old snapshots and backups stay decryptable**. Only a tiny "lock around the key" is
  replaced; not one snapshot is rewritten.
- **Shared folder** = one DEK for the whole folder; the passphrase is just the wrapping.
  Everyone unwraps the same DEK, so everyone can always read every snapshot.

### Where the wrapped DEK lives: the keyring

The wrapped DEK is stored in a **keyring**, kept in the shared Drive folder as its own
immutable, versioned file (tagged `pfApp=portfolio-keyring`, separate from snapshots which
are `pfApp=portfolio`):

```jsonc
// pf-keyring-<version>.pfkeyring  (one shared per folder; latest = max version)
{
  "format": "pf-keyring-v1",
  "version": 3,                       // monotonic; bumped on every password change
  "dekId": "b1f2…",                   // stable random id of THIS DEK (folder-data identity)
  "kdf": { "salt": "…", "iterations": 600000 },
  "wrappedDEK": { "iv": "…", "ciphertext": "…" }   // DEK bytes, AES-GCM-encrypted by the KEK
}
```

Everything in the keyring is safe to be public: without the passphrase there is no KEK, and
without the KEK the `wrappedDEK` is undecryptable noise. **The plaintext DEK and the
passphrase are never written to Drive.** The successful AES-GCM unwrap *is* the passphrase
check — it authenticates, so a wrong passphrase fails to unwrap. (This supersedes the old
`vaultCheck` sentinel; the keyring is the verification token.)

Snapshots become simpler — they carry no per-file KDF anymore, just data sealed with the DEK:

```jsonc
// pfdb-v2   (data encrypted with the DEK; no salt/kdf in the header)
{ "format": "pfdb-v2", "iv": "…", "ciphertext": "…" }
```

### `dekId` — the folder-data identity

Previously the "which vault is this" identity used for session/engine tracking was the KDF
**salt**. Under envelope encryption the salt belongs to the *password* (it changes on a
password change) while the *data* is identified by the DEK. So a new stable field, `dekId`
(a random id minted with the DEK, carried in the keyring and cached locally), becomes the
vault/data identity. A password change keeps the same `dekId` (same DEK) → the sync session
file is preserved; only a genuinely different DEK (fresh vault / different folder) starts a
new session.

### Migration path (v1 → v2), per device

The reader is **backward compatible**; the writer only writes v2.

- **v2 can read both formats.** A `pfdb-v1` file → derive the old direct key from
  `passphrase + that file's embedded kdf` and decrypt. A `pfdb-v2` file → decrypt with the
  DEK. So no old data is ever stranded.
- **First device to run v2 against a folder that has snapshots but no keyring** performs the
  migration on unlock:
  1. Unlock the v1 way (derive the direct key, verify against the latest v1 snapshot).
  2. **Mint a fresh random DEK** (+ `dekId`).
  3. **Create keyring v1**: wrap the DEK with `KEK = PBKDF2(passphrase, salt)`.
  4. **Push one fresh `pfdb-v2` snapshot** of the current state (which already lives in local
     plaintext) at `version = max + 1`.
  5. Cache the DEK in the keystore + the keyring locally.
- **No bulk re-encryption.** Only the *latest* snapshot matters for sync, and the current
  state is already local plaintext, so we just write it once as v2. Old v1 snapshots remain
  as history (still decryptable via passphrase + their embedded kdf if ever restored) and
  simply age out via the normal prune (each device prunes only its own files).
- **Subsequent devices** find the keyring, unwrap the DEK with the shared passphrase, and
  read v2 snapshots directly — no migration step.

**Web-app caveat.** All devices load the same GitHub Pages build, so everyone gets v2 on
their next page load. The only risk window is an **old (pre-v2) tab left open** that receives
a v2 "latest" it cannot parse — its old code raises a decode error (there is no graceful
"reload to continue" prompt: an already-running old build predates this format and can't be
taught to detect it). This is **not data loss** — that tab's own edits stay in its local
IndexedDB and re-sync once it reloads. So after a deploy, **reload open tabs** — that is the
whole migration for a device.

### Keyring sync + concurrency (the shared-folder rules)

The keyring rides the **same discipline the snapshots already use**: monotonic `version`,
immutable-latest-wins, pull-before-push, and a post-write TOCTOU re-check.

- **Adopt (on unlock/sync):** `Drive.keyring.version > local` → pull it, unwrap the DEK,
  cache both. `local > Drive` **or Drive keyring missing**, and we hold the DEK → push the
  local keyring up.
- **Change/reset password:** `version = max(localSeen, driveLatest) + 1`; wrap the DEK with
  the new passphrase; create the new keyring file; TOCTOU re-check — if a higher-versioned
  keyring already appeared, another device re-keyed first, so we adopt theirs instead of
  clobbering. **This writes only the keyring — no snapshot is touched.**
- **Accidental keyring deletion is recoverable.** Any device that holds the DEK (in its
  keystore) + its locally cached keyring can simply re-upload it; the DEK is unchanged so all
  snapshots stay readable. Same resilience as re-pushing a lost `.pfdb`.

The invariant that makes all of this safe: **the DEK never changes.** Two devices
re-creating the keyring concurrently is harmless — both wrap the *same* DEK (shared
passphrase), so unwrapping either yields the same DEK and every snapshot stays readable. The
version guard is not protecting the *data* (the DEK is invariant); it only protects **which
passphrase is current**, so a stale old-passphrase keyring can't overwrite a newer
new-passphrase one and lock out devices that already moved.

The one genuinely tricky case — rare with a shared household password — is **two concurrent
password changes**. Both bump to the same next version; the TOCTOU loser re-reads, sees the
winner, and reconciles. The folder ends with one winning keyring (highest version); the
losing passphrase stops working; the affected device shows *"the password was changed on
another device — enter the new one."* It can keep operating meanwhile on its cached DEK; it
only needs the new passphrase the next time it locks/unlocks. This is inherent
last-writer-wins for the *passphrase*, never for the *data*.

### Forgot-password recovery posture

- If **a device is currently unlocked** (holds the DEK — i.e. it auto-restored the key from
  its keystore on load and is showing your data), it can **re-wrap that DEK under a new
  passphrase without the old one** via **Change password**, and every file stays readable.
  This is the real, non-destructive recovery, and is why the DEK is stored **extractable**
  (see the security trade-off below). Note: a device that was explicitly **locked** ("Require
  password again") has *cleared* its key, so it can't self-recover — do the Change password on
  a device that's still open.
- If **no device is unlocked and everyone forgot the passphrase**, the `wrappedDEK` in the
  keyring is unopenable and the *Drive* copy is unrecoverable — this is end-to-end encryption
  with no backdoor, by design. But each device's **local** data is plaintext, so nothing is
  actually lost: **Reset password** re-keys from an up-to-date device's local data (guarded so
  it can't run from a device that's behind and would orphan newer shared data).

### Security trade-off (deliberate, documented)

The DEK is stored in the keystore as an **extractable** `CryptoKey` (the old direct key was
non-extractable). Extractability is required to re-wrap the DEK under a new passphrase for the
held-key recovery path above. The cost: an XSS payload running in the page origin could export
the DEK.

We accept this because **the local portfolio data is already stored as plaintext in
IndexedDB** — the passphrase only ever protected the *Drive snapshots and exported backups*,
not the local DB. So an attacker with script execution in the origin can already read all the
data directly; exfiltrating the DEK exposes no *additional* data (the shared folder's
snapshots contain the same data). The primary control remains **preventing XSS** (strict CSP,
React escaping, no `dangerouslySetInnerHTML`, minimal dependencies); key storage is
secondary defense-in-depth. Given the intended use (a family's own shared folder, no
"revoke a member" adversary) the trade-off is sound. Revisit it if the local DB ever becomes
encrypted-at-rest.

### Known bounds (accepted, non-destructive)

Two narrow multi-device windows are bounded rather than fully eliminated; neither
destroys data (snapshots are immutable and the DEK is invariant):

- **Concurrent edit during the one-time migration.** A device migrating v1→v2
  publishes a v2 baseline from the folder's latest v1 data (which it adopts) after a
  "current-device" guard. If *another still-v1* device pushes an edit in the ~1s
  window between that guard and the baseline push, the baseline floors at the
  guard-time version so `runSync`'s pull-before-push guard *detects* the newer
  snapshot and refuses (rather than silently superseding it). **Nothing is lost:**
  that straggler's edit lives in its own local IndexedDB and re-syncs (as a v2
  snapshot) the moment it reloads into v2 — the deploy step is "reload open tabs."
  The catch the migrated device can't do is *merge* the straggler's v1-encrypted
  snapshot before then (its DEK-only codec can't decode a v1 file); it shows a
  transient "another device is still finishing the upgrade — try again shortly"
  message. Requires two v1 devices editing within that window during a one-time
  event — very unlikely for a family, and non-destructive.
- **Straggler keyring pruning.** `KEYRING_KEEP` (20) bounds how many past
  password generations stay on Drive. A device that has been offline across more
  than that many password changes *and* holds no DEK could find its only
  unwrappable keyring pruned. The latest keyring is never pruned, and any device
  that holds the DEK is unaffected (an older keyring wraps the same invariant DEK),
  so this needs 20+ password changes plus a never-unlocking, DEK-less device.

### Data-safety guards on the mint / re-key paths

Because minting or enshrining the *wrong* DEK is the one way this design could lose a
folder, every path that writes a keyring is guarded so it can't fork over data it
doesn't own:

- **Fresh-mint (setup / migration) refuses over an established folder.** `createFreshVault`
  and the migration path will not mint a new DEK when the folder already holds a v2
  snapshot but its keyring is momentarily missing/invisible (deleted, or propagation
  lag) — they surface "already encrypted, key not available yet — try again" instead
  of superseding the folder's real data. (A *deliberate* forgotten-password `resetPassword`
  is the one path that intentionally supersedes; it is guarded separately, below.)
- **No forking on a transient Drive error.** Every keyring/KDF read on the mint paths
  lets a network error *propagate* (never `catch → null → mint`), so a blip can't cause
  a device to fork a fresh DEK over a populated folder.
- **Forgotten-password reset only from an up-to-date device.** `resetPassword`'s
  destructive fresh-mint refuses when this device is *behind* the folder (its local
  state would orphan newer shared data); it points the user to reset from a current
  device, or to `changePassword` on a device that's still unlocked (non-destructive).
- **Wrong-folder / rotation drop.** A device carrying a v2 vault that connects to a folder
  it doesn't own is dropped rather than allowed to stamp its keyring: `reconcileVaultWithFolder`
  drops the local vault when the folder's keyring has a different `dekId`, OR when there is no
  keyring but the folder's latest snapshot is a legacy v1 file (a foreign / not-yet-migrated
  folder). And during sync, `ensureRemoteKeyring` **never lifts our keyring over a newer
  different-`dekId` keyring** (a reset elsewhere whose new-DEK baseline may not be visible
  yet) — it drops and requires re-unlock, so a stale DEK can't be re-enshrined authoritative
  over rotated data.
- **Concurrent change-vs-reset.** `changePassword` detects a concurrent destructive reset via
  the keyring's mirrored `dekId` appProperty (a same-or-higher-version keyring with a
  different `dekId`) — cheaply, from the listing, before the reset's baseline snapshot is even
  visible — and drops rather than enshrining a stale-DEK keyring over new-DEK data. The one
  residual sub-case — a change that WINS the keyring `(version,id)` tiebreak while a
  concurrent reset owns the newer data DEK — resolves as a **non-destructive wedge**, not a
  split: `ensureRemoteKeyring`/`reconcileVaultWithFolder` deliberately key their drop off the
  authoritative *winner* keyring's `dekId` (NOT the mere presence of any different-`dekId`
  keyring — firing on a benign equal-version *loser* keyring, e.g. from a concurrent migration,
  would livelock drop→re-unlock→drop), so the winning device isn't auto-dropped; instead
  runSync's `sessionVerified` backstop refuses to push once it can't decode the reset's
  baseline. No committed data is lost (all local plaintext survives); the folder needs a manual
  reconnect/re-key to converge. This requires two conflicting password operations on two
  devices within the same sub-second — astronomically rare for a family.

### Backward-compatibility summary

| Reader build | `pfdb-v1` snapshot | `pfdb-v2` snapshot | keyring |
|---|---|---|---|
| **v1 (old)** | ✅ reads | ❌ can't parse → decode error until the tab is reloaded | ignores (unknown tag) |
| **v2 (new)** | ✅ reads (passphrase + file's kdf) | ✅ reads (DEK) | ✅ reads/writes |

No data migration is destructive; the only manual step is **reload open tabs after
deploying v2**.
