// Plain-language explanations shown behind every ⓘ in the retirement
// calculator.  Kept in one place so the wording stays consistent and is easy
// to review.  Write for someone who has never used a financial calculator.

import { ASSUMED_INTEREST } from "../../utils/portfolioImport";
import { DEFAULT_COMPARE_ITERATIONS } from "../../utils/retirementSolver";

export const HELP = {
  // ---- Basic details ------------------------------------------------------
  basics:
    "The few numbers everything else builds on: your age, when you plan to stop working, how fast prices rise, and what you expect to spend.",
  currentAge: "Your age today, in whole years.",
  retirementAge:
    "The age you stop working and start living off your savings. Monthly savings stop at this age.",
  inflation:
    "How fast prices rise each year on average. India's long-run consumer inflation has been around 5 to 6%. Every amount you enter at today's prices is grown at this rate.",
  expenseType: "Choose whether you enter your spending per month or per year.",
  spend:
    "What you expect to spend once retired, at today's prices: food, bills, travel, everything except healthcare if you enter that separately below. It grows with inflation until you retire and is then paid from your savings every month.",
  planAge:
    "How long the money has to last. Planning to 90 or 95 is common, because running out of money in old age is the bigger risk.",
  autosave:
    "Your inputs are saved automatically in this browser as you type. They are not synced to other devices.",

  // ---- Existing investments ------------------------------------------------
  existing:
    "Money you have already invested: mutual funds, shares, FDs, PF, gold and so on. Each bucket grows at its own rate until you retire. On your retirement day everything is pooled and re-split using your post-retirement allocation.",
  amount: "What this investment is worth today.",
  returnAfterTax:
    "Expected average growth per year after tax, over the long run (CAGR, the figure fund factsheets quote). Rough guide after tax: savings or FD 4 to 6%, debt funds 5 to 7%, large-cap equity 10 to 12%.",
  volatility:
    "How much a single year can swing above or below that average (the standard deviation). Only the Monte Carlo simulation uses it. Rough guide: FD or liquid fund 0 to 1, debt fund 2 to 4, gold about 15, large-cap equity 15 to 18, mid or small-cap 20 to 25. Leave it blank to use the default from Monte Carlo settings.",
  volatilityRetirement:
    "How much a single year can swing above or below that average (the standard deviation). The Monte Carlo simulation uses it, and with the bucket strategy it also decides which bucket counts as safest (lowest volatility is spent first), so it changes the expected path too. Rough guide: FD or liquid fund 0 to 1, debt fund 2 to 4, gold about 15, large-cap equity 15 to 18, mid or small-cap 20 to 25. Leave it blank to use the default from Monte Carlo settings.",
  importPortfolio:
    "Fill these buckets from what you track in the Portfolio tab: your investments plus the balances of your bank, cash, fixed-deposit, crypto and property accounts (credit cards and loans are left out). It only reads your Portfolio data on this device; nothing there is changed.",
  importTaxToday:
    "The income-tax rate you pay on interest now. FD and bank interest is taxed every year, so the suggested return for those groups is their yearly interest minus this tax (7% a year at a 30% rate suggests 4.9%). It starts at the tax rate you set for retirement; change it if you pay a different rate today. It only changes the suggestions here.",
  importBank: `Everything in your bank, cash and brokerage-cash accounts. The suggested return uses each account's interest rate from Portfolio, after your tax rate today. A bank account with no rate set is assumed to earn ${ASSUMED_INTEREST.bank}% (a typical savings rate), cash in hand ${ASSUMED_INTEREST.cash}% and brokerage cash ${ASSUMED_INTEREST.brokerage}%. If most of it sits in a current account that earns nothing, lower the return. If part of it is an emergency fund or money you'll spend soon, untick this, or import it and lower the amount in the bucket afterwards.`,
  importFd: `Your fixed deposits, valued as Portfolio values them (FDs that reinvest their interest include the interest earned so far). The suggested return is what they earn in a year with compounding counted (7% compounded quarterly works out to 7.19%; an FD that pays its interest out earns just its rate), after your tax rate today. An FD with no rate set in Portfolio is assumed to earn ${ASSUMED_INTEREST.fd}%.`,
  importVolatility:
    "How much a single year can swing above or below the average (the standard deviation). Only the Monte Carlo simulation uses it. The suggestion is a typical figure for this kind of money. 0 means it earns exactly its average return every year, with no ups and downs, so keep a figure for shares, gold or crypto. You can change it later in the bucket.",

  // ---- Monthly savings -------------------------------------------------------
  savings:
    "What you invest every month until retirement: SIPs, recurring deposits, PF contributions. Each month's amount is invested at the end of the month.",
  monthly: "How much you invest in this bucket each month right now.",
  stepUp:
    "How much you raise this monthly amount every year, for example with pay rises. 5 to 10% is common. 0 keeps it flat for the whole time, which usually understates what you will end up saving.",
  glide:
    "Gradually moves this bucket into safer investments in the last few years before a linked goal, so a market fall just before you need the money hurts less.",
  targetRate:
    "Return of the safer investment you move into near the goal, for example a debt fund or FD.",
  glideYears: "How many years before the goal to start moving the money.",

  // ---- One-time expenses ---------------------------------------------------
  oneTime:
    "Big future costs such as a car, a child's education or a wedding. Each one is paid from your savings in the year it falls due.",
  yearsFromNow: "How many years from now you will pay for it.",
  costToday: "What it would cost if you paid for it today.",
  expenseInflation:
    "How fast this particular cost rises each year. Education often rises 8 to 10% a year, cars 4 to 6%.",
  fundedBy:
    "Pick a monthly savings bucket to pay this goal first (a 'sinking fund'); anything it can't cover comes from your other savings. For a goal after retirement, only what the goal needs is set aside on your retirement day and the rest of that bucket joins your retirement money.",

  // ---- Income in retirement --------------------------------------------------
  income:
    "Money that keeps coming in after you retire: pension, annuity, rent, part-time work. It reduces how much you have to withdraw. Income before your retirement date is ignored here, because it is assumed to be what funds your savings.",
  incomeAmount:
    "How much you receive each month. For income that rises with inflation, enter it in today's money. For fixed or custom income, enter the actual amount you will get in its first year.",
  incomeStart: "The age this income starts.",
  incomeEnd: "The age it stops. Leave it empty if it lasts for life.",
  incomeGrowth:
    "Rises with inflation: keeps its buying power, like rent or an inflation-linked pension. Fixed: the same rupee amount forever, like most annuities. Custom: grows by the % you choose each year.",
  incomeGrowthRate: "How much this income grows each year, in %.",
  incomeTaxable:
    "Tick if this income is taxed. It is reduced by your income-tax rate (set under Tax & withdrawals).",

  // ---- Spending changes ------------------------------------------------------
  phases:
    "Many people spend less as they get older: less travel, more time at home. Set how your everyday spending changes from a given age, as a % of the amount you entered. Healthcare is handled separately.",
  phaseFrom: "The age this level of spending starts.",
  phasePercent:
    "Everyday spending from that age, as a % of what you entered above. 100% means no change.",
  healthcare:
    "Medical costs usually rise faster than other prices, so they get their own line and their own inflation rate.",
  healthMonthly:
    "What you expect to spend on healthcare each month (insurance premiums, medicines, check-ups), at today's prices.",
  healthInflation:
    "How fast medical costs rise each year. In India this has run at roughly 10 to 14%.",
  healthStart:
    "The age these costs start being paid from your savings. Leave it empty to start at retirement.",

  // ---- Post-retirement allocation ------------------------------------------
  allocationSection:
    "How your savings are split once you retire. Each bucket grows at its own rate while you draw money out of them.",
  allocation:
    "Share of your retirement money in this bucket. The shares don't have to add up to exactly 100%; they are scaled.",
  returnPreTax:
    "Expected average growth per year. If you pick a tax treatment, enter the return BEFORE tax, and tax is then worked out on what you withdraw. With 'No tax', enter the return after tax.",
  taxTreatment:
    "How this bucket is taxed (rates are set under Tax & withdrawals). No tax: the return is already after tax, or the money is tax-free (PPF, EPF). Equity: the profit part of what you withdraw is taxed at the equity LTCG rate, above the yearly tax-free amount (12.5% and ₹1.25 lakh by default). Debt fund: the profit part of what you withdraw is taxed at your income-tax rate. FD / interest: interest is taxed at your income-tax rate every year, whether you withdraw it or not. Only growth after you retire is taxed, because the returns you enter before retirement are already after tax.",

  // ---- Tax & withdrawals -----------------------------------------------------
  taxSection:
    "How tax is worked out on money you take out in retirement, and which buckets your spending comes out of.",
  incomeTaxRate:
    "Your highest income-tax rate in retirement, the rate on your last rupee of income. Under the new tax regime, total income up to about ₹12 lakh a year is effectively tax-free after the rebate, so enter 0 if that applies to you.",
  ltcgRate: "Tax on long-term profits from equity. 12.5% under current rules.",
  ltcgExemption:
    "Equity profit you can take each year without paying tax: ₹1.25 lakh per person under current rules. If your investments are split between two people's own names, each person gets their own exemption, so you could enter up to double. Jointly held funds are usually taxed in the first holder's name only.",
  strategy:
    "Which buckets your monthly spending comes out of. Proportional: from every bucket in proportion to its size, so your mix drifts toward whatever grew most. Rebalance yearly: the same, then reset to your target split at the end of each year (selling winners can create tax). Bucket strategy: spend from the safest bucket (the one with the lowest Volatility %) and refill it from the growth buckets only after a year they didn't lose money, so a crash doesn't force you to sell shares as long as the safe bucket lasts. If it runs dry, spending comes from the next safest bucket.",
  cashBuffer:
    "Bucket strategy only: how many years of spending to keep in the safest bucket, counting only the part your income doesn't cover (spending minus pension, rent and so on).",

  // ---- Monte Carlo settings ------------------------------------------------
  mcSettings:
    "The simulation doesn't assume every year earns the average. It replays your plan thousands of times with random good and bad years for markets and inflation, to show how likely the plan is to work. These settings control how wild those years can be.",
  defaultVolatility:
    "Used for any bucket whose Volatility % is left blank. 12% is roughly a balanced mix of equity and debt.",
  inflationVolatility:
    "How much inflation can differ from your expected rate in a single year. 1 to 2.5% is typical for India.",
  inflationPersistence:
    "How 'sticky' inflation is. At 0, a high-inflation year is followed by a normal one. Higher values mean high inflation tends to last several years, as it does in real economies. 0.5 to 0.7 is realistic.",
  fatTails:
    "Real markets have occasional crash or boom years bigger than a smooth bell curve predicts. With this on, the simulation mixes in rarer, bigger shocks while keeping about the same overall volatility.",
  iterations:
    "How many random futures to simulate. More gives steadier numbers but takes longer.",

  // ---- Results ---------------------------------------------------------------
  verdict:
    "Combines two views of your plan: the expected path, where every year earns exactly the average, and the simulation, where good and bad years come in random order.",
  corpusAtRetirement:
    "Everything you are projected to have on your retirement day, in rupees of that future date. Because prices rise, those rupees buy less than today's; the 'today's money' line shows what the same amount would buy at today's prices.",
  returnInRetirement:
    "The blended yearly return of your post-retirement buckets as you entered them (before tax for buckets with a tax treatment, after tax for 'No tax' ones). 'Real' takes inflation off: it is how fast your money grows in buying power.",
  mixBeforeRetirement:
    "The value-weighted average return of everything you have saved, just before it is re-split for retirement.",
  spendToday: "Your yearly everyday spending as you entered it, at today's prices.",
  spendAtRetirement:
    "What your yearly spending (including healthcare) will cost in your first year of retirement, after inflation.",
  incomeAtRetirement:
    "Your yearly income in your first year of retirement (pension, rent and so on), after tax.",
  withdrawalRate:
    "What you take out of your savings in the first year (spending minus income) as a % of your savings at retirement. Lower is safer: 3 to 4% is a common rule of thumb for a 30-year retirement, and above 5% rarely lasts.",
  lastsYears: "How many years after retirement your savings cover your spending on the expected path.",
  lastsAge: "The age your savings run out on the expected path.",
  successRate:
    "Out of all the simulated futures, the share in which you never run out of money before your plan age.",
  badCase:
    "In the unluckiest 10% of simulated futures, the age by which your money runs out.",
  finalCorpus:
    "What could be left at your plan age. P10: only 10% of futures end lower (a bad outcome). Median: half end higher, half lower. P90: only 10% end higher (a lucky outcome).",
  todayVsFuture:
    "Today's ₹ shows every amount at today's prices, adjusted for inflation, which is easier to judge: at 6% inflation, ₹1 crore in 30 years buys what about ₹17 lakh buys today. Future ₹ shows the actual rupee amounts on those future dates.",
  chart:
    "How your savings could move over time across all simulated futures. The darker band holds the middle half of outcomes, the lighter band 80% of them. The solid line is the median future; the dashed line is the expected path where every year earns the average.",
  goalsResult:
    "How each one-time expense gets paid in the expected path: from its linked savings bucket, from your general savings, or not at all if the money has run out.",
  yearByYear:
    "Your savings at the end of each year on the expected path. Saved: money you put in. Growth: what your investments earned. Spent: living costs paid, including healthcare. Income: pension, rent and so on received. Tax: tax paid on withdrawals and interest.",

  // ---- Solver & scenarios ----------------------------------------------------
  solver:
    "Works out what would change the plan enough to reach your target success rate: saving more each month, retiring at a different age, or spending less. It runs the simulation many times, so it takes a few seconds.",
  solverTarget:
    "The success rate you are aiming for. 85 to 90% is a common target; aiming for 100% means planning for the very worst case and saving far more than you probably need.",
  scenarios:
    "Save the current inputs under a name and compare plans side by side, for example 'retire at 55' against 'retire at 60'. Loading a scenario replaces the current inputs.",
  compare: `Runs each selected plan (expected path plus a quicker ${DEFAULT_COMPARE_ITERATIONS.toLocaleString("en-IN")}-run simulation) and lines up the key numbers.`,
  keyMetrics:
    "Headline numbers for the expected path, where every year earns exactly the average return you entered.",
  portfolioToday:
    "How the money you have already invested is split today, by bucket. It changes at retirement to your post-retirement allocation.",
  whoseInvestments:
    "Pick one person, the things marked as shared, or everyone. Each investment and account counts in full for its owner as set in the Portfolio: an account marked as shared counts under Shared, even if only one person pays into it. Family members you've archived still appear, marked (archived), if they still own something with a value or something that had to be left out. Choose what this retirement plan should cover.",
  compareRows:
    "Savings at retirement is shown in today's money. 'Expected path lasts to' assumes average returns every year; 'Success rate' and 'Bad case' come from the simulation.",
} as const;
