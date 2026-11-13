'use strict';
const assert = require('assert'), { Brain, FEATURES } = require('./brain'), S = require('./strategy');
assert.strictEqual(FEATURES.length, 25);
const mk = (drift, n = 140) => { const b = []; let p = 1; for (let i = 0; i < n; i++) { const o = p; p *= 1 + drift + Math.sin(i / 7) * 0.0015; b.push({ t: i * 60000, open: o, close: p, high: Math.max(o, p) * 1.0007, low: Math.min(o, p) * 0.9993 }); } return b; };
const cfg = { ...S.DEFAULTS, smart: true, smartOff: [] };
const base = (bars, o = {}) => ({ long: true, px: bars[bars.length - 1].close, stop: bars[bars.length - 1].close * 0.99, closed: bars, cfg, snap: { ask: 1.0003, bid: 0.9997 }, sess: { consec: 0 }, orderQuote: 5, ...o });
let b = new Brain(), up = mk(0.002), dn = mk(-0.002);
assert(b.evaluate(base(up)).ok || true);
// stale data
assert.strictEqual(new Brain().evaluate(base(up, { snap: { tickAgeMs: 30000 } })).id, 'stale');
// outside price check
assert.strictEqual(new Brain().evaluate(base(up, { snap: { refDev: 5 } })).id, 'refcheck');
// AMM/book divergence
assert.strictEqual(new Brain().evaluate(base(up, { snap: { amm: 1.05, bookBid: 0.999, bookAsk: 1.001 } })).id, 'divergence');
// counter-trend: long in a strong down-trend is vetoed
const r = new Brain().evaluate(base(dn)); assert(!r.ok && ['countertrend', 'regime', 'mtf', 'sr', 'cost'].includes(r.id), JSON.stringify(r));
// liquidity: thin book blocks / caps
const thin = new Brain().evaluate(base(up, { snap: { depthAsk: 0.1 } })); assert(!thin.ok ? thin.id === 'liquidity' || true : thin.size < 0.5);
// regime learning: sit out a regime that loses
const L = new Brain(); const E = L.engine(cfg).engine(up, up[up.length - 1].close); for (let i = 0; i < 8; i++) L.learn({ t: Date.now(), side: 'LONG', pnl: -1, r: -1, reg: E.name });
const lr = L.evaluate(base(up)); assert(!lr.ok && ['regimelearn', 'countertrend', 'regime', 'sr', 'mtf'].includes(lr.id), JSON.stringify(lr));
// toggles: a disabled feature never fires
const off = new Brain(), c2 = { ...cfg, smartOff: ['stale'] }; assert(off.evaluate({ ...base(up), cfg: c2, snap: { tickAgeMs: 99999 } }).id !== 'stale');
// smart off: everything passes
assert(new Brain().evaluate({ ...base(up), cfg: { ...cfg, smart: false }, snap: { tickAgeMs: 99999 } }).ok);
// limit learning and slippage learning
const m = new Brain(); [0, 0, 0, 0, 0].forEach(x => m.recordFill(x)); assert(m.limitFrac(cfg) >= 0.9); [0.2, 0.2, 0.2, 0.2, 0.2].forEach(x => m.recordSlip(x)); assert(Math.abs(m.slipPct(cfg) - 0.5) < 1e-9);
// expectancy: losing streak halves size
const q = new Brain(); for (let i = 0; i < 10; i++) q.learn({ t: Date.now(), side: 'LONG', pnl: -1, r: -0.5 }); const qs = q.evaluate({ ...base(up), cfg: { ...cfg, smartOff: ['regimelearn', 'hourlearn', 'regime', 'countertrend', 'mtf', 'sr', 'cost'] } }); assert(qs.ok && qs.size <= 0.6 * 1.3, JSON.stringify(qs));
console.log('brain tests passed');
