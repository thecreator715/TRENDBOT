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
- Not yet in the live bot (simulator-only): hedge (long+short), Smart Auto regime gating, reversed pairs.
- Start with a small wallet. Run `node test.js` after any change.
