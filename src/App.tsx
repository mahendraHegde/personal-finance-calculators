import { useState } from "react";
import RetirementCalculator from "./components/retirement_calculator";
import { PortfolioApp } from "./features/portfolio/ui/PortfolioApp";

type AppId = "portfolio" | "retirement";

function App() {
  const [app, setApp] = useState<AppId>("portfolio");

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="flex justify-center gap-1 border-b border-slate-200 bg-white px-4 py-2">
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
        <PortfolioApp />
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
