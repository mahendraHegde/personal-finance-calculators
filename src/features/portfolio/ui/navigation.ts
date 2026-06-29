// Tiny tab-navigation seam. The active top-level tab lives in the app shell;
// this context lets any nested component (e.g. a hint linking to Settings)
// switch tabs without prop-drilling. No router dependency.

import { createContext, useContext } from "react";

export type TabId = "dashboard" | "expenses" | "investments" | "accounts" | "settings";

export const NavContext = createContext<(tab: TabId) => void>(() => undefined);

/** Switch the active top-level tab. */
export function useNavigate(): (tab: TabId) => void {
  return useContext(NavContext);
}
