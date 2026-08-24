// Pure readings of sync state for the UI: what the pill says, and which notices stand.
//
// They live outside the component files so they can be tested without a renderer — this project
// has no DOM harness, so as in-component code every mutation of these rules survived the suite,
// and two of them (a banner pair that always co-occurred, a next step that dead-ended once the
// vault re-locked) were live bugs in the rules themselves.

import { SYNC_TEXT, type StartupCheck, type SyncStatus } from "../state/sync-controller";
import { SignInRequiredError } from "../../../lib/google/drive-auth";
import type { BadgeTone } from "./components";

/** The three readings of `lastCheck`, for `syncSituation` below (which is what the components
 *  actually call). Separate and exported because the union's shape is the whole point — a failed
 *  look must not read as "0 behind, checked just now" — and that is worth pinning on its own. */
export function readLastCheck(
  lastCheck: SyncStatus["lastCheck"],
): { behind: number; unreachable: boolean; checkedAt: string | null } {
  return {
    behind: lastCheck && "behind" in lastCheck ? lastCheck.behind : 0,
    unreachable: !!lastCheck && "unreachable" in lastCheck,
    // Only a SUCCESSFUL look is a "checked at" — a failed one must not license a "Synced · HH:MM".
    checkedAt: lastCheck && "behind" in lastCheck ? lastCheck.at : null,
  };
}

/** A message a person can act on. Errors thrown by this app are already written as sentences;
 *  platform failures ("TypeError: Failed to fetch") are not, and the startup gate can route
 *  straight here, making this banner the first thing seen on launch. */
export function humanError(e: unknown): string {
  // Deliberately says nothing about WHICH service: this is the funnel for every failure in
  // Settings, including refreshing exchange rates and restoring a backup, and a `TypeError` from
  // `fetch` means "the request never left" whatever the subsystem.
  if (e instanceof TypeError)
    return "Couldn't reach the network just now — check your connection and try again.";
  if (e instanceof SignInRequiredError) return `${SYNC_TEXT.authExpired} — reconnect Google to resume syncing.`;
  // `e.message` for ANY Error: the class name is never part of it, so this covers every subclass.
  // Stripping a literal "Error:" prefix only worked for the base class.
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Does this outcome give back the shell's one-check-per-app-start slot?
 *
 *  Pure and here rather than inline in the effect because it is a RULE, and rules that live inside
 *  a component in this project have gone untested and wrong: a locked run that failed still owes
 *  us a real check once the vault opens, and a run that found no folder looked at nothing at all —
 *  spending the slot on it means the folder the user connects a minute later is never checked,
 *  which is exactly when it is most likely to hold data this device has never seen. Everything
 *  else — including a failed FULL run — keeps the slot: an offline device flips syncing→error on
 *  every autosave, and re-arming the gate on each flip put the whole app behind an overlay every
 *  few seconds. */
export function refundsCheckSlot(kind: StartupCheck["kind"], claim: "locked" | "full"): boolean {
  return kind === "no-folder" || (kind === "unavailable" && claim === "locked");
}

/** "1 snapshot" / "2 snapshots". */
function count(n: number): string {
  return `${n} snapshot${n === 1 ? "" : "s"}`;
}

/** Whichever word agrees with the count. Separate from `count` because the subject and its verb
 *  are not adjacent in these sentences ("N snapshots from your other devices haven't…") — gluing
 *  them together is how "1 snapshot hasn't from your other devices been loaded" shipped. */
function agree(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** What the user is asked to do. The shell binds these to its handlers; keeping them as names
 *  rather than callbacks is what lets two notices be compared for "same action". */
export type SyncActionKind = "settings" | "review" | "dismiss-applied";

export interface SyncNoticeSpec {
  key: "problem" | "applied" | "next";
  /** Matches the pill's meaning for the same fact — a red pill over an amber banner saying the
   *  same sentence reads as two different severities for one problem. */
  tone: "red" | "amber" | "slate" | "green";
  text: string;
  action: { label: string; kind: SyncActionKind };
  /** Raw diagnostic, hover only. */
  title?: string;
}

/** What the pill MEANS. Not a class string: Settings paints it as a badge and the header as
 *  text, and the module that decides the meaning has no business knowing either. */
export type SyncTone = "ok" | "warn" | "bad" | "idle";

/** The colour NAME each meaning gets, once. The header paints it as text and Settings as a badge,
 *  but which colour means "warn" is one decision — as two tables, the header could go amber while
 *  the badge went green for the same state, which is the contradiction this module exists to
 *  prevent. */
export const SYNC_TONE_COLOR: Record<SyncTone, BadgeTone> = {
  ok: "green",
  warn: "amber",
  bad: "red",
  idle: "slate",
};

export interface SyncSituation {
  pill: { label: string; tone: SyncTone; title?: string };
  notices: SyncNoticeSpec[];
}

/** Everything the shell renders about sync, derived in ONE place.
 *
 *  The pill and the banners used to be two precedence chains over the same fields, in different
 *  orders and with different membership — so the pill could say "Behind — 2 to load" with a
 *  tooltip left over from the last successful save while the banner said the folder was
 *  unreadable. They are one derivation now, and the exclusivity rules below are the point of it:
 *  two amber banners that say the same thing, with two buttons that call the same handler, read
 *  as two problems. */
export function syncSituation(
  status: SyncStatus,
  opts: { dismissedApplied?: number | null; formatTime?: (iso: string) => string } = {},
): SyncSituation {
  const { behind, unreachable, checkedAt } = readLastCheck(status.lastCheck);
  const formatTime =
    opts.formatTime ?? ((iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
  const locked = status.phase === "locked";

  // ---- the one banner that says what is WRONG, if anything is.
  let primary: SyncNoticeSpec | null = null;
  if (status.phase === "error" && status.message) {
    primary = {
      key: "problem",
      tone: "red",
      text: status.message,
      action: status.needsAuth
        ? { label: "Reconnect", kind: "settings" }
        : { label: "Open sync", kind: "settings" },
      title: status.detail,
    };
  } else if (status.problem) {
    // The startup check reports problems WITHOUT setting `phase` (a failed read must not gate
    // autosave off for the session), so it needs its own branch or it reaches a tooltip and
    // nowhere else. Its diagnostic travels with it rather than in the shared `detail`.
    primary = {
      key: "problem",
      tone: "amber",
      text: status.problem.text,
      // Locked, "Try again" would reach `checkRemote`, which cannot decode anything and throws a
      // developer string. Same rule as the two branches below — applied here too, not just where
      // it happened to bite first.
      action: locked ? { label: "Unlock", kind: "settings" } : { label: "Try again", kind: "review" },
      title: status.problem.detail,
    };
  }

  // ---- and the one line about what to do NEXT, most actionable first. `about` is what the step
  // is FOR, which is what decides whether it survives next to a problem banner.
  let next: SyncNoticeSpec | null = null;
  let about: "behind" | "transport" | null = null;
  if (locked && behind > 0) {
    // While the vault is locked nothing can be decoded, so "Review" would open a dialog that
    // cannot load anything. Keyed on the LIVE phase, not on the startup result: re-locking after
    // the check would otherwise leave "Review now" as the only offer, and it dead-ends in a
    // developer string ("sync not ready").
    about = "behind";
    next = {
      key: "next",
      tone: "amber",
      text: `${count(behind)} from your other devices ${agree(behind, "is", "are")} waiting. Unlock to load ${agree(behind, "it", "them")} — editing before that means merging later.`,
      action: { label: "Unlock", kind: "settings" },
    };
  } else if (behind > 0 && status.needsAuth) {
    // Being behind used to outrank being disconnected, so an expired sign-in went unnamed whenever
    // there was also something to load — and "Review now" was offered to a session that cannot
    // reach Drive at all. (New combination: the startup check sets `needsAuth` WITHOUT `phase`, so
    // that the failed read doesn't gate autosave off for the session.) Both facts, one sentence,
    // under the button that unblocks the other.
    about = "behind";
    next = {
      key: "next",
      tone: "amber",
      text: `Sync is disconnected. ${SYNC_TEXT.authExpired}, and ${count(behind)} from your other devices ${agree(behind, "hasn't", "haven't")} been loaded here yet.`,
      action: { label: "Reconnect", kind: "settings" },
    };
  } else if (behind > 0) {
    about = "behind";
    next = {
      key: "next",
      tone: "amber",
      text: `${count(behind)} from your other devices ${agree(behind, "hasn't", "haven't")} been loaded here yet. Editing before loading ${agree(behind, "it", "them")} means merging later.`,
      action: { label: "Review now", kind: "review" },
    };
  } else if (status.needsAuth) {
    about = "transport";
    next = locked
      ? {
          // Settings shows no Reconnect control while locked (that row needs ready/syncing/error),
          // so naming it would send the user to a screen that can't do it.
          key: "next",
          tone: "amber",
          text: "Sync is disconnected and this device is locked. Unlock to reconnect — until then your changes are saved on this device only.",
          action: { label: "Unlock", kind: "settings" },
        }
      : {
          key: "next",
          tone: "amber",
          text: `Sync is disconnected. ${SYNC_TEXT.authExpired}. Your changes are saved on this device only.`,
          action: { label: "Reconnect", kind: "settings" },
        };
  } else if (unreachable) {
    about = "transport";
    next = {
      key: "next",
      tone: "slate",
      text: `${SYNC_TEXT.unreachable}. Your changes are saved on this device and will sync when it's reachable.`,
      action: { label: "Settings", kind: "settings" },
    };
  }

  // ---- one problem, one next step — and never twice over.
  if (primary && next) {
    if (about === "behind") {
      // These two ALWAYS co-occur. The push guard sets its error only after recording a listing
      // with at least one file unread ("Remote has newer changes — Pull latest" + "2 snapshots
      // haven't been loaded here yet"), and a failed startup read can only happen inside the
      // behind branch. Two amber banners with two buttons for one situation reads as two
      // problems. Keep the sentence that says what is wrong, take the action that resolves it,
      // and fold the count in so nothing is lost.
      primary = {
        ...primary,
        text: `${primary.text} ${count(behind)} still to load.`,
        // The next step's action, always — including when the banner is about sign-in, because
        // the branch that builds it for a disconnected-and-behind device already says Reconnect
        // (and Unlock for a locked one, which is what should win there).
        action: next.action,
      };
    }
    // A transport step next to a problem banner is dropped outright: the banner already names
    // that failure and carries its own action.
    next = null;
  }

  const notices: SyncNoticeSpec[] = [];
  if (primary) notices.push(primary);
  if (status.appliedVersion !== undefined && status.appliedVersion !== opts.dismissedApplied) {
    notices.push({
      key: "applied",
      tone: "green",
      text: `Loaded the latest changes from your other device (v${status.appliedVersion}).`,
      action: { label: "Dismiss", kind: "dismiss-applied" },
    });
  }
  if (next) notices.push(next);

  // ---- the pill, from the SAME facts. Its tooltip is the standing banner's diagnostic, never
  // whatever `message` a long-finished operation left behind.
  const problemText = status.problem?.text;
  const busy = status.phase === "syncing";
  // Loudest fact first. Not a nested ternary any more: the ordering IS the rule — a push in
  // progress must never outrank something that is actually wrong — and it has to be readable to
  // stay right.
  const pill = ((): SyncSituation["pill"] => {
    if (status.phase === "error") {
      return { label: "Sync error", tone: "bad", title: status.detail ?? status.message };
    }
    if (behind > 0) {
      // A push in progress does not settle what is still unread, so it is appended to the louder
      // fact rather than replacing it.
      return {
        label: busy ? `Syncing… · ${behind} to load` : `Behind — ${behind} to load`,
        tone: "warn",
        title: problemText,
      };
    }
    if (problemText) return { label: "Check failed", tone: "warn", title: problemText };
    if (status.needsAuth) return { label: "Not connected", tone: "warn", title: SYNC_TEXT.authExpired };
    if (unreachable) {
      // Quieter than a problem, and matching its slate banner: nothing is wrong with the data, the
      // folder just isn't answering. A separate label from the sign-in case, which IS actionable —
      // one label carrying two different severities read as a bug.
      return { label: "Offline", tone: "idle", title: SYNC_TEXT.unreachable };
    }
    if (busy) return { label: "Syncing…", tone: "ok", title: undefined };
    if (status.phase === "ready") {
      // "Synced" is only honest once the folder has actually been LOOKED at and found equal — it
      // used to show for a device that had never checked.
      return checkedAt
        ? { label: `Synced · ${formatTime(checkedAt)}`, tone: "ok", title: "Last checked the shared folder" }
        : { label: "Not checked yet", tone: "idle", title: undefined };
    }
    // Not all "no sync" is the same thing, and this label is ALSO the Settings badge — where
    // "Local only" for a locked vault, a folderless device and an unencrypted one told the user
    // nothing about what to do next.
    if (status.phase === "locked") return { label: "Locked", tone: "idle", title: "Unlock this device to sync" };
    if (status.phase === "no-vault") {
      return { label: "No password", tone: "idle", title: "Set a password to enable encrypted sync" };
    }
    return { label: "Local only", tone: "idle", title: undefined };
  })();

  return { pill, notices };
}
