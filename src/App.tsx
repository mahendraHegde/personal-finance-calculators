import { useState } from "react";
import RetirementCalculator from "./components/retirement_calculator";
import { PortfolioApp } from "./features/portfolio/ui/PortfolioApp";

type AppId = "portfolio" | "retirement";

function App() {
  const [app, setApp] = useState<AppId>("portfolio");
  // The portfolio blocks itself while it checks Drive on start. The switcher lives OUTSIDE that
  // subtree, so without this it stayed tabbable behind the full-screen overlay — and switching
  // apps mid-check hands the user a calculator they can't see, under a spinner they can't dismiss.
  const [gating, setGating] = useState(false);

  return (
    <div className="min-h-screen bg-slate-50">
      <div
        className="flex justify-center gap-1 border-b border-slate-200 bg-white px-4 py-2"
        // …but only while its overlay is actually ON SCREEN. The portfolio subtree is
        // `display:none` when the other app is showing, so the overlay renders into nothing —
        // and the switcher would go dead for up to 8 seconds with no visible explanation.
        inert={(gating && app === "portfolio") || undefined}
      >
        <Switch active={app === "portfolio"} onClick={() => setApp("portfolio")}>
          Portfolio
        </Switch>
        <Switch active={app === "retirement"} onClick={() => setApp("retirement")}>
          Retirement
        </Switch>
      </div>

      {/* Both stay mounted — switching apps must not tear down the portfolio's
          store/sync session (which would break "one Drive file per session"). */}
      <div className={app === "portfolio" ? "" : "hidden"}>
        <PortfolioApp onGating={setGating} />
      </div>
      <div
        className={
          app === "retirement"
            ? "flex justify-center bg-gradient-to-br from-blue-100 to-purple-200 p-4"
            : "hidden"
        }
      >
        <RetirementCalculator />
      </div>
    </div>
  );
}

function Switch({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
        active ? "bg-blue-600 text-white" : "text-slate-500 hover:bg-slate-100"
      }`}
    >
      {children}
    </button>
  );
}

export default App;
