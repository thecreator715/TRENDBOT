# TRENDBOT

Trend-following bot + local control UI for **XRPL mainnet** (XRP/RLUSD and any token pair with an AMM pool or order book).

## Run (live)
```
npm install
BOT_SEED=sEd... node bot.js     # or start without it and import a seed on the Wallet page
# open http://127.0.0.1:8787
```
With a wallet connected the bot trades **real funds** on mainnet. The seed is kept in memory only, never written or logged. The UI/API binds to 127.0.0.1 only. Create a file named `STOP` in this folder to halt and flatten at any time.

## What it does
- Entry on higher-high/higher-low (long) or lower-high/lower-low (short) candle structure, stop from the second candle.
- Exits: structure / ATR / % / step trailing, TP ladder partials, breakeven, giveback, time stop, trend-flip.
- Filters: chop (efficiency), higher-timeframe, volatility, max trades/day.
- Risk: risk-based sizing, halve risk after 2 losses, daily loss halt, consecutive-loss halt, per-pair wallet % (`/api/alloc`) and daily goal.
- Shorting is an **inventory short** (sell base you hold, buy back lower). XRPL has no margin.

## Honest limits
- Nothing here guarantees profit or prevents losses. Stops are polled, not on-ledger; gaps and thin books slip past them.
- Not yet in the live bot (simulator-only): hedge (long+short), reversed pairs. Smart Auto is live in v3.0.
- Start with a small wallet. Run `node test.js` after any change.

## Your analytics are permanent
Trades and the equity history are saved in history.json (with history.bak.json as a rolling backup) next to bot.js. Restarts, Resume and deleting state.json do not erase them. When updating, copy the new files over the old folder and keep history.json. Do not delete it unless you want to start the analytics from zero.

## Smart Auto brain (v3.0, ON by default)
25 safeguards (regime score gate, counter-trend veto, cost/liquidity/divergence/stale-data guards, learned sizing, adaptive exits, auto re-tune and more) run on every automatic entry. Each can be switched off in the Smart tab. Manual Buy/Short bypass it. It reduces bad entries; it cannot guarantee profit.

## Simultaneous pairs + GateHub BTC (v3.1)
BTC/XRP (GateHub BTC, issuer rchGBxcD1A1C2tdxF6papQYZ8kjRKMYcL) is built in. On the Trade tab, each pair card has a TRADING/OFF switch: every pair that is ON runs its own signals, orders, stops and analytics at the same time on the one wallet. Add the BTC trust line on the Wallet tab first (one click). Pairs share XRP, so BTC/XRP defaults to 50% of the wallet; adjust per pair with the allocation control. Fills are now read from each transaction's own metadata, so one pair's trades never distort another's accounting. Send/receive works for any asset with a trust line.
BTC/XRP chart is seeded at start with ~16h of 1-minute history (Bitstamp BTC/USD divided by XRP/USD), like XRP/RLUSD. Click any pair card on the Trade tab to switch the chart.
ETH/XRP (GateHub ETH, issuer rcA8X3TVMST1n3CJeAdGk1RdRCHii7N2h) is built in too, with its own chart history. Pair cards show size, entry, stop, target and live R for any open position.

## v3.4 request-rate and robustness
All pairs share one wallet snapshot, one offers list and one book_changes read per ledger, cutting XRPL requests to roughly half with three pairs (public servers rate-limit); on a rate-limit error the bot pauses 8s and fails over to the next server. Wallets with more than 400 trust lines are paged. The wallet equity history is thinned automatically so history.json stays small.
