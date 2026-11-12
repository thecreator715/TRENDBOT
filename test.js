'use strict';
const assert = require('assert');
const S = require('./strategy');
const cfg = { ...S.DEFAULTS, ...require('./config.json') };
const c = (t, low, high) => ({ t, open: low, high, low, close: high });

// trend + signals
assert.strictEqual(S.trend(c(0, 1.0, 1.1), c(1, 1.05, 1.2)), 'UP');
assert.strictEqual(S.trend(c(0, 1.0, 1.1), c(1, 0.9, 1.05)), 'DOWN');
assert.strictEqual(S.trend(c(0, 1.0, 1.1), c(1, 0.95, 1.2)), 'NONE');
assert.strictEqual(S.trend(c(0, 1.0, 1.1), c(1, 1.02, 1.08)), 'NONE');
const up = [c(0, 2.00, 2.02), c(1, 2.01, 2.04)];
assert.strictEqual(S.entrySignal(up, 2.03, cfg).enter, false);
const e = S.entrySignal(up, 2.045, cfg);
assert.ok(e.enter && e.stop < 2.01 && e.stop > 2.0 && e.target > 2.045);
assert.strictEqual(S.entrySignal([c(0, 1.5, 2.0), c(1, 1.6, 2.1)], 2.11, cfg).enter, false);
assert.strictEqual(S.entrySignal([c(0, 2, 2.1)], 2.2, cfg).enter, false);
assert.strictEqual(S.entrySignal([c(0, 2.0, 2.1), c(1, 1.9, 2.0)], 2.2, cfg).enter, false);

// filters
assert.strictEqual(S.entrySignal(up, 2.045, { ...cfg, minER: 0.5 }, { er: 0.2 }).enter, false);
assert.strictEqual(S.entrySignal(up, 2.045, { ...cfg, minER: 0.5 }, { er: 0.8 }).enter, true);
assert.strictEqual(S.entrySignal(up, 2.045, { ...cfg, htfFilter: true }, { htf: [c(0, 2.2, 2.4), c(1, 2.0, 2.3)] }).enter, false);
assert.strictEqual(S.entrySignal(up, 2.045, { ...cfg, maxTradesPerDay: 2 }, { tradesToday: 2 }).enter, false);
assert.strictEqual(S.entrySignal(up, 2.045, { ...cfg, maxAtrPct: 0.5 }, { atrPct: 1 }).enter, false);
const atrStop = S.entrySignal(up, 2.045, { ...cfg, stopMode: 'atr', atrStopMult: 1, maxStopPct: 10 }, { atr: 0.05 });
assert.ok(atrStop.enter && atrStop.stop < e.stop, 'ATR stop is wider than structure stop');

// sizing
assert.strictEqual(S.sizeQuote(1000, 1000, 0.5, cfg), 500);
assert.ok(Math.abs(S.sizeQuote(1000, 1000, 4, cfg) - 250) < 1e-9);
assert.ok(S.sizeQuote(1000, 100, 4, cfg) === 100);
assert.ok(Math.abs(S.sizeQuote(1000, 1000, 4, cfg, 0.5) - 125) < 1e-9);
assert.strictEqual(S.riskScale(2, cfg), 0.5); assert.strictEqual(S.riskScale(1, cfg), 1);

// long manage
const L = () => ({ side: 'LONG', entry: 2.0, stop: 1.98, stop0: 1.98, target: 2.2, entryCandleT: 1 });
assert.strictEqual(S.manage(L(), 1.97, [c(0, 2, 2.1), c(1, 2.01, 2.2)], cfg).reason, 'stop');
assert.strictEqual(S.manage(L(), 2.21, [c(0, 2, 2.1), c(1, 2.01, 2.2)], cfg).reason, 'take-profit');
const tr = S.manage(L(), 2.1, [c(1, 2.0, 2.1), c(2, 2.06, 2.15)], cfg);
assert.ok(tr.stop > 2.05 && !tr.exit, 'structure trail raises stop');
assert.strictEqual(S.manage({ stop: 1.0, target: null, entryCandleT: 1, entry: 2, stop0: 1 }, 2.0, [c(1, 2.0, 2.2), c(2, 1.95, 2.1)], cfg).reason, 'trend-flip');
// breakeven at +1R
const be = S.manage(L(), 2.021, [c(0, 2, 2.1)], cfg); assert.ok(be.stop >= 2.0 && !be.exit, 'auto breakeven');
// user stop disables trailing
const us = { ...L(), userStop: true }; assert.strictEqual(S.manage(us, 2.1, [c(1, 2.0, 2.1), c(2, 2.06, 2.15)], { ...cfg, autoBE: false }).stop, 1.98);
// pct trail
const pt = L(); S.manage(pt, 2.1, [], { ...cfg, trailMode: 'pct', trailPct: 1, trailActivateR: 1, autoBE: false });
assert.ok(S.manage(pt, 2.09, [], { ...cfg, trailMode: 'pct', trailPct: 1, trailActivateR: 1, autoBE: false }).stop > 2.07, 'pct trail from peak');
assert.strictEqual(S.manage(pt, 2.0789, [], { ...cfg, trailMode: 'pct', trailPct: 1, trailActivateR: 1, autoBE: false, ...{} }).exit, true);
// step trail locks 1R behind
const st = L(); const sm = S.manage(st, 2.07, [], { ...cfg, trailMode: 'step', autoBE: false, takeProfitR: 0 }); // +3.5R -> lock 2R
assert.ok(sm.stop > 2.03, 'step trail locks profit: ' + sm.stop);
// ATR chandelier
const ac = L(); const am = S.manage(ac, 2.1, [], { ...cfg, trailMode: 'atr', atrMult: 2, autoBE: false }, { atr: 0.02 });
assert.ok(Math.abs(am.stop - 2.06) < 1e-9, 'chandelier = peak - 2*ATR');
// giveback
const gb = L(); S.manage(gb, 2.08, [], { ...cfg, givebackPct: 40, givebackAfterR: 2, autoBE: false });
assert.strictEqual(S.manage(gb, 2.04, [], { ...cfg, givebackPct: 40, givebackAfterR: 2, autoBE: false, trailMode: 'none' }).reason, 'giveback');
// TP ladder: partial levels fire in order and only once
const ld = { ...L(), target: null }; const lcfg = { ...cfg, tpLadder: [{ r: 1, pct: 30 }, { r: 2, pct: 30 }, { r: 3, pct: 40 }], autoBE: false };
let m1 = S.manage(ld, 2.021, [], lcfg); assert.ok(Math.abs(m1.partial - 0.3) < 1e-9 && m1.level === 0); ld.done = [0];
m1 = S.manage(ld, 2.021, [], lcfg); assert.strictEqual(m1.partial, undefined);
m1 = S.manage(ld, 2.045, [], lcfg); assert.strictEqual(m1.level, 1);
// time stop
const ts = L(); assert.strictEqual(S.manage(ts, 2.001, [c(2, 1.99, 2.01), c(3, 1.99, 2.01), c(4, 1.99, 2.01)], { ...cfg, timeStopBars: 3, autoBE: false }).reason, 'time-stop');

// short side
const dn = [c(0, 1.91, 1.97), c(1, 1.90, 1.93)];
assert.strictEqual(S.shortSignal(dn, 1.95, cfg).enter, false);
const sg = S.shortSignal(dn, 1.895, cfg); assert.ok(sg.enter && sg.stop > 1.93 && sg.target < 1.895);
assert.strictEqual(S.shortSignal([c(0, 2.0, 2.1), c(1, 1.9, 2.0)], 1.89, cfg).enter, false);
assert.strictEqual(S.shortSignal(up, 2.0, cfg).enter, false);
assert.strictEqual(S.shortSignal(dn, 1.895, { ...cfg, htfFilter: true }, { htf: [c(0, 1.8, 1.9), c(1, 1.85, 1.95)] }).enter, false);
const sh = { side: 'SHORT', entry: 2.0, stop: 2.02, stop0: 2.02, target: 1.8, entryCandleT: 1 };
assert.strictEqual(S.manageShort({ ...sh }, 2.03, [c(0, 1.9, 2.1), c(1, 1.8, 1.95)], cfg).reason, 'stop');
assert.strictEqual(S.manageShort({ ...sh }, 1.79, [c(0, 1.9, 2.1), c(1, 1.8, 1.95)], cfg).reason, 'take-profit');
const trd = S.manageShort({ ...sh }, 1.9, [c(1, 1.8, 1.95), c(2, 1.75, 1.9)], { ...cfg, autoBE: false }); assert.ok(trd.stop < 1.95 && !trd.exit, 'short trail down');
assert.strictEqual(S.manageShort({ stop: 3, stop0: 3, entry: 2, target: null, entryCandleT: 1 }, 1.9, [c(1, 1.8, 1.95), c(2, 1.85, 2.0)], cfg).reason, 'trend-flip');
const stS = { ...sh }; assert.ok(S.manageShort(stS, 1.93, [], { ...cfg, trailMode: 'step', autoBE: false }).stop < 2.0, 'short step trail');
assert.ok(S.sizeShortBase(1000, 2, 2.04, 100, cfg) <= 50);

// aggregate (HTF) + candle building from ticks
const base = []; for (let i = 0; i < 12; i++) base.push({ t: i, open: 1 + i * .01, high: 1.02 + i * .01, low: .98 + i * .01, close: 1.01 + i * .01 });
const ag = S.aggregate(base, null, 4); assert.strictEqual(ag.length, 2); assert.strictEqual(ag[0].high, 1.02 + 3 * .01);
const ticks = []; for (let i = 0; i < 600; i++) ticks.push([i * 5000, 2 + Math.sin(i / 30) * 0.05]);
const c1 = S.buildCandles(ticks, 1), c5 = S.buildCandles(ticks, 5), c15 = S.buildCandles(ticks, 15);
assert.ok(c1.closed.length >= 49 && c5.closed.length >= 9 && c15.closed.length >= 3, 'all timeframes built from the same ticks');
assert.strictEqual(Math.max(...c5.closed.map(x => x.high)) <= Math.max(...c1.closed.map(x => x.high)) + 1e-12, true);

// backtester sanity on a synthetic uptrend vs chop (no crash, sane numbers)
function walk(n, drift, seed) { let s = seed, px = 2; const r = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; const out = [];
  for (let i = 0; i < n; i++) { const o = px; let hi = o, lo = o; for (let k = 0; k < 20; k++) { px *= 1 + drift + (r() - .5) * .004; hi = Math.max(hi, px); lo = Math.min(lo, px); } out.push({ t: i, open: o, high: hi, low: lo, close: px }); } return out; }
const bu = S.backtest(walk(300, 0.0003, 11), cfg), bc = S.backtest(walk(300, 0, 12), cfg);
assert.ok(bu.n > 3 && isFinite(bu.net) && bu.curve.length > 100);
console.log('backtest up:', bu.n, 'trades', bu.net.toFixed(1), 'pf', bu.pf.toFixed(2), '| chop:', bc.n, 'trades', bc.net.toFixed(1), 'pf', bc.pf.toFixed(2));
const op = S.optimize(walk(400, 0.00015, 21), cfg); assert.ok(op.rows.length <= 5 && op.trainN > 200);
console.log('optimizer top:', op.rows.length ? JSON.stringify(op.rows[0].g) + ' train pf ' + op.rows[0].r.pf.toFixed(2) + ' -> out-of-sample pf ' + op.rows[0].oos.pf.toFixed(2) : 'none');
console.log('all strategy tests passed');
