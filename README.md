# Personal Finance Calculators

## Live Demo

[https://mahendrahegde.github.io/personal-finance-calculators/](https://mahendrahegde.github.io/personal-finance-calculators/)

A collection of interactive personal-finance tools built with React, TypeScript, and Vite. It includes a **Retirement Calculator** and a **local-first Portfolio & Expenses tracker**, and is designed for easy extension with more tools in the future.

## Features

- **Portfolio & Expenses Tracker** — a privacy-first, local-first personal-finance app (see below).
- **Retirement Calculator** — estimate your retirement savings and plan for the future.
- **Modern Tech Stack** — React, TypeScript, Vite, and Tailwind CSS.
- **Responsive + installable** — works on desktop and mobile; installable as a PWA.
- **Easy Deployment** — auto-deployed to GitHub Pages on every push to `main`.

## Portfolio & Expenses Tracker

A privacy-first net-worth, investment, and expense tracker. **All data lives in your browser**
(IndexedDB); it never goes to a server. You can optionally sync an **end-to-end-encrypted** snapshot
to a Google Drive folder you choose, for backup and family sharing.

- **Accounts, transactions & categories** — income / expense / transfer, multi-currency (per-date
  FX), two-level categories, per-family-member ownership, and a yearly income/expense breakdown.
- **Investments** — holdings with buys/sells/dividends, since-inception **XIRR**, data-quality
  badges, and multi-broker support (the same security held across brokers). Optional **live prices**
  for stocks/ETFs and Indian mutual funds (GOOGLEFINANCE via your own Google Sheet), crypto
  (CoinGecko), and MF NAV (mfapi.in).
- **Dashboard** — net worth, per-person and family rollups, asset allocation, per-account/broker
  concentration, monthly income-vs-expense trend, and spending/income by category. Sections are
  hidden by default and computed on demand; financial figures sit behind an eye toggle for privacy.
- **Backup & sync** — encrypted `.pfdb` file export/restore, and conflict-safe Google Drive sync
  (no auto-merge; changes are reviewed via a diff before applying). A passphrase derives a
  non-extractable key held in the browser.
- **Archive, not delete** — a person/account/category still referenced by history can't be deleted
  (it would orphan records); archive it instead to hide it from menus while keeping history intact.

**Enabling Drive sync (optional):** create a Google Cloud OAuth **client ID** (and API key for the
Picker), enable the **Drive** and **Sheets** APIs in that project, then paste the client ID / API key
in the app's **Settings** and pick a folder. No client secret is used (a static site can't hold one).
See `docs/PLAN.md` for the full design.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or newer recommended)
- [npm](https://www.npmjs.com/) (comes with Node.js)

### Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/mahendraHegde/personal-finance-calculators.git
cd personal-finance-calculators
npm install
```

### Running Locally

Start the development server:

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser to view the app.

### Building for Production

To build the app for production:

```bash
npm run build
```

The output will be in the `dist` directory.

### Deployment

This project is automatically deployed to GitHub Pages using a GitHub Actions workflow (`.github/workflows/deploy.yml`). The site is published from the `dist` directory to the `gh-pages` branch.

To deploy manually:

```bash
npm run deploy
```

## Project Structure

- `src/components/retirement_calculator.tsx` – Retirement Calculator component
- `src/features/portfolio/` – Portfolio & Expenses tracker
  - `model/` – entity types + storage schema
  - `domain/` – pure compute (XIRR, net worth, allocation, transactions)
  - `repo/`, `state/` – typed repositories + the reactive store & sync controller
  - `ui/` – React screens (Dashboard, Expenses, Investments, Accounts, Settings)
- `src/lib/` – app-agnostic, reusable: `storage/` (pluggable adapters), `money/`, `sync/`,
  `crypto/`, `google/` (Drive + Sheets)
- `tests/` – framework-free `tsx` test suites (`npm test`)
- `docs/PLAN.md` – design plan, decisions, and divergences

## Testing

```bash
npm test          # run all suites (domain, store, storage, prices, backup)
npx tsc -b        # type-check
```

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

This project is licensed under the MIT License.
