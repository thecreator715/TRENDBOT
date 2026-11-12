'use strict';
// Single source of truth: used by bot.js (Node) and inlined into the UI build (browser).
// Long : higher high + higher low (c1 older, c2 newer closed candle), buy break of c2.high, stop under c2.low.
// Short: lower high + lower low, sell (inventory) on break of c2.low, stop above c2.high.
// Optional profit/risk controls (all in cfg, all off or conservative by default):
//   minER (trend-efficiency filter) · htfFilter (higher-timeframe agreement) · maxAtrPct (skip extreme volatility)
//   autoBE (stop to breakeven at +1R) · tpLadder [{r,pct}] multi-level scale-out (or partialPct at +1R) · timeStopBars
//   trailMode 'structure' | 'atr' (chandelier, atrMult) | 'pct' (trailPct from peak after +trailActivateR) | 'step' (locks 1R behind each new R)
//   givebackPct (exit if price gives back this % of peak profit once past givebackAfterR) · stopMode 'structure' | 'atr' (wider of the two)
//   lossScale (halve risk after 2 straight losses) · maxTradesPerDay · dailyProfitLockPct

const DEFAULTS = {
  maxStopPct: 3, riskPerTradePct: 1, takeProfitR: 2, maxPositionPct: 50, stopBufferPct: 0.15, dailyLossHaltPct: 3,
  maxConsecutiveLosses: 3, cooldownCandles: 1, shortInventoryPct: 50, slip: 0.05,
  minER: 0, htfFilter: false, maxAtrPct: 0, autoBE: true, partialPct: 0, tpLadder: [], timeStopBars: 0, trailMode: 'structure', atrMult: 2.5,
  trailPct: 1.2, trailActivateR: 1, givebackPct: 0, givebackAfterR: 2, stopMode: 'structure', atrStopMult: 1.8,
  lossScale: true, noFlipExit: false, maxTradesPerDay: 0, dailyProfitLockPct: 0,
};
const C = cfg => ({ ...DEFAULTS, ...cfg });

function trend(c1, c2) {
  if (!c1 || !c2) return 'NONE';
  if (c2.high > c1.high && c2.low > c1.low) return 'UP';
  if (c2.high < c1.high && c2.low < c1.low) return 'DOWN';
  return 'NONE';
}

// ---- indicators used by filters ----
function atrOf(bars, n = 14) {
  if (bars.length < n + 1) return null;
  let a = null;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    const tr = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
    if (i === n) { let s = 0; for (let j = 1; j <= n; j++) { const x = bars[j], q = bars[j - 1]; s += Math.max(x.high - x.low, Math.abs(x.high - q.close), Math.abs(x.low - q.close)); } a = s / n; }
    else if (i > n) a = (a * (n - 1) + tr) / n;
  }
  return a;
}
function efficiency(bars, n = 20) {
  if (bars.length < n + 1) return null;
  const w = bars.slice(-(n + 1)).map(b => b.close);
  let path = 0; for (let i = 1; i < w.length; i++) path += Math.abs(w[i] - w[i - 1]);
  return path ? Math.abs(w[w.length - 1] - w[0]) / path : 0;
}
function ctxFrom(closed, htf, extra = {}) {
  const atr = atrOf(closed), last = closed[closed.length - 1];
  return { atr, atrPct: atr && last ? (atr / last.close) * 100 : null, er: efficiency(closed), htf: htf || null, ...extra };
}
function filterWhy(cfg, ctx, dir) {
  if (!ctx) return null;
  if (cfg.minER > 0 && ctx.er != null && ctx.er < cfg.minER) return `trend efficiency ${ctx.er.toFixed(2)} < ${cfg.minER} (chop filter)`;
  if (cfg.maxAtrPct > 0 && ctx.atrPct != null && ctx.atrPct > cfg.maxAtrPct) return `volatility ${ctx.atrPct.toFixed(2)}% > ${cfg.maxAtrPct}%`;
  if (cfg.htfFilter && ctx.htf && ctx.htf.length >= 2) {
    const t = trend(ctx.htf[ctx.htf.length - 2], ctx.htf[ctx.htf.length - 1]);
    if (dir === 'long' && t === 'DOWN') return 'higher timeframe is DOWN';
    if (dir === 'short' && t === 'UP') return 'higher timeframe is UP';
  }
  if (cfg.maxTradesPerDay > 0 && ctx.tradesToday >= cfg.maxTradesPerDay) return `max ${cfg.maxTradesPerDay} trades/day reached`;
  return null;
}

function entrySignal(candles, price, cfgIn, ctx) {
  const cfg = C(cfgIn);
  if (candles.length < 2) return { enter: false, trend: 'NONE', why: 'warming up (need 2 closed candles)' };
  const c1 = candles[candles.length - 2], c2 = candles[candles.length - 1], t = trend(c1, c2);
  if (t !== 'UP') return { enter: false, trend: t, why: `trend ${t}, stay in quote asset` };
  if (price <= c2.high) return { enter: false, trend: t, why: `uptrend, waiting for break above ${c2.high.toPrecision(6)}` };
  const fw = filterWhy(cfg, ctx, 'long');
  if (fw) return { enter: false, trend: t, why: fw };
  let stop = c2.low * (1 - cfg.stopBufferPct / 100);
  if (cfg.stopMode === 'atr' && ctx && ctx.atr) stop = Math.min(stop, price - cfg.atrStopMult * ctx.atr);
  const stopPct = ((price - stop) / price) * 100;
  if (stopPct > cfg.maxStopPct) return { enter: false, trend: t, why: `stop ${stopPct.toFixed(2)}% wider than max ${cfg.maxStopPct}%` };
  if (stopPct <= 0) return { enter: false, trend: t, why: 'invalid stop' };
  const target = cfg.takeProfitR > 0 ? price + (price - stop) * cfg.takeProfitR : null;
  return { enter: true, trend: t, stop, stopPct, target, why: 'break above second-candle high in uptrend' };
}
function shortSignal(candles, price, cfgIn, ctx) {
  const cfg = C(cfgIn);
  if (candles.length < 2) return { enter: false, why: 'warming up' };
  const c1 = candles[candles.length - 2], c2 = candles[candles.length - 1];
  if (trend(c1, c2) !== 'DOWN') return { enter: false, why: 'no downtrend for a short' };
  if (price >= c2.low) return { enter: false, why: `downtrend, waiting for break below ${c2.low.toPrecision(6)}` };
  const fw = filterWhy(cfg, ctx, 'short');
  if (fw) return { enter: false, why: fw };
  let stop = c2.high * (1 + cfg.stopBufferPct / 100);
  if (cfg.stopMode === 'atr' && ctx && ctx.atr) stop = Math.max(stop, price + cfg.atrStopMult * ctx.atr);
  const stopPct = ((stop - price) / price) * 100;
  if (stopPct > cfg.maxStopPct) return { enter: false, why: `short stop ${stopPct.toFixed(2)}% wider than max ${cfg.maxStopPct}%` };
  const target = cfg.takeProfitR > 0 ? price - (stop - price) * cfg.takeProfitR : null;
  return { enter: true, side: 'SHORT', stop, stopPct, target, why: 'break below second-candle low in downtrend' };
}

const riskScale = (consec, cfgIn) => { const c = C(cfgIn); return c.lossScale && consec >= 2 ? 0.5 : 1; };
function sizeQuote(equityQuote, availQuote, stopPct, cfgIn, scale = 1) {
  const cfg = C(cfgIn);
  const byRisk = (equityQuote * (cfg.riskPerTradePct * scale / 100)) / (stopPct / 100);
  return Math.max(0, Math.min(byRisk, equityQuote * (cfg.maxPositionPct / 100), availQuote));
}
function sizeShortBase(equityQuote, price, stop, baseAvail, cfgIn, scale = 1) {
  const cfg = C(cfgIn);
  const byRisk = (equityQuote * (cfg.riskPerTradePct * scale / 100)) / Math.max(stop - price, 1e-12);
  const byCap = (equityQuote * (cfg.maxPositionPct / 100)) / price;
  return Math.max(0, Math.min(byRisk, byCap, baseAvail * (cfg.shortInventoryPct / 100)));
}

// manage(): returns { stop, exit, reason, partial? }. Also tracks excursions on pos (hi/lo for MFE/MAE, beDone).
function manageSide(sh, pos, price, closed, cfgIn, ctx) {
  const cfg = C(cfgIn), out = { stop: pos.stop, exit: false, reason: null };
  pos.hi = Math.max(pos.hi ?? price, price); pos.lo = Math.min(pos.lo ?? price, price);
  const s0 = pos.stop0 ?? pos.stop, r1 = Math.abs(pos.entry - s0) || 1e-12;
  const favNow = sh ? pos.entry - price : price - pos.entry;           // distance in our favour right now
  const favMax = sh ? pos.entry - pos.lo : pos.hi - pos.entry;          // best distance reached (MFE)
  const rNow = favNow / r1, rMax = favMax / r1;
  const last = closed[closed.length - 1], newer = last && last.t > pos.entryCandleT;
  const raise = v => { if (sh ? v < out.stop : v > out.stop) out.stop = v; };
  if (!pos.userStop) {
    const mode = cfg.trailMode;
    if (mode === 'atr') { if (ctx && ctx.atr && rMax >= (cfg.trailActivateR || 0) * 0) raise(sh ? pos.lo + cfg.atrMult * ctx.atr : pos.hi - cfg.atrMult * ctx.atr); }
    else if (mode === 'pct') { if (rMax >= cfg.trailActivateR) raise(sh ? pos.lo * (1 + cfg.trailPct / 100) : pos.hi * (1 - cfg.trailPct / 100)); }
    else if (mode === 'step') { const lock = Math.floor(rMax) - 1; if (lock >= 0) raise(sh ? pos.entry - lock * r1 - pos.entry * 0.0006 : pos.entry + lock * r1 + pos.entry * 0.0006); }
    else if (newer) raise(sh ? last.high * (1 + cfg.stopBufferPct / 100) : last.low * (1 - cfg.stopBufferPct / 100));
  }
  if (cfg.autoBE && rMax >= 1) raise(sh ? pos.entry * (1 - 0.0006) : pos.entry * (1 + 0.0006));
  if (sh ? price >= out.stop : price <= out.stop) return { ...out, exit: true, reason: 'stop' };
  if (pos.target && (sh ? price <= pos.target : price >= pos.target)) return { ...out, exit: true, reason: 'take-profit' };
  if (cfg.givebackPct > 0 && rMax >= cfg.givebackAfterR && favNow < favMax * (1 - cfg.givebackPct / 100)) return { ...out, exit: true, reason: 'giveback' };
  const ladder = cfg.tpLadder && cfg.tpLadder.length ? cfg.tpLadder : (cfg.partialPct > 0 ? [{ r: 1, pct: cfg.partialPct }] : []);
  pos.done = pos.done || [];
  for (let k = 0; k < ladder.length; k++) if (!pos.done.includes(k) && rNow >= ladder[k].r) { out.partial = ladder[k].pct / 100; out.level = k; break; }
  if (!pos.userStop && !cfg.noFlipExit && closed.length >= 2) {
    const c1 = closed[closed.length - 2], c2 = closed[closed.length - 1];
    if (c2.t > pos.entryCandleT && trend(c1, c2) === (sh ? 'UP' : 'DOWN')) return { ...out, exit: true, reason: 'trend-flip' };
  }
  if (cfg.timeStopBars > 0) { const nb = closed.filter(c => c.t > pos.entryCandleT).length; if (nb >= cfg.timeStopBars && rNow < 0.5) return { ...out, exit: true, reason: 'time-stop' }; }
  return out;
}
const manage = (pos, price, closed, cfg, ctx) => manageSide(false, pos, price, closed, cfg, ctx);
const manageShort = (pos, price, closed, cfg, ctx) => manageSide(true, pos, price, closed, cfg, ctx);

class Candles {
  constructor(tfMinutes, closed = [], current = null) { this.tf = tfMinutes * 60_000; this.closed = closed; this.cur = current; }
  push(ts, price) {
    const t = Math.floor(ts / this.tf) * this.tf; let closedNow = null;
    if (!this.cur) this.cur = { t, open: price, high: price, low: price, close: price };
    else if (t > this.cur.t) { closedNow = this.cur; this.closed.push(this.cur); if (this.closed.length > 1000) this.closed.shift(); this.cur = { t, open: price, high: price, low: price, close: price }; }
    else { this.cur.high = Math.max(this.cur.high, price); this.cur.low = Math.min(this.cur.low, price); this.cur.close = price; }
    return closedNow;
  }
}
// Build candles of any timeframe from raw ticks [[ts, price], ...] so every timeframe uses the same real data.
function buildCandles(ticks, tfMinutes) {
  const c = new Candles(tfMinutes);
  for (const [ts, px] of ticks) c.push(ts, px);
  return c;
}
const aggregate = (closed, cur, k) => { // higher timeframe from base candles, bucket by k base candles
  const all = cur ? closed.concat([cur]) : closed, out = [];
  if (!all.length) return out;
  const tf = k;
  let i = all.length;
  const groups = [];
  while (i > 0) { groups.unshift(all.slice(Math.max(0, i - tf), i)); i -= tf; }
  groups.forEach(g => out.push({ t: g[0].t, open: g[0].open, close: g[g.length - 1].close, high: Math.max(...g.map(x => x.high)), low: Math.min(...g.map(x => x.low)) }));
  return out.slice(0, -1).length ? out.slice(0, -1) : out; // drop the (possibly incomplete) newest group
};

// ---- candle-level backtester (conservative: stop is checked before target within a candle) ----
function backtest(bars, cfgIn, opt = {}) {
  const cfg = C(cfgIn), start = opt.start || 1000, fee = (cfg.slip || 0.05) / 100;
  let eq = start, pos = null, cool = -1, consec = 0, peak = start, mdd = 0; const trades = [], curve = [start];
  const close = (i, px, reason, frac = 1, level = null) => {
    const sh = pos.side === 'SHORT', q = frac < 1 ? Math.min(pos.base, pos.base0 * frac) : pos.base, fill = sh ? px * (1 + fee) : px * (1 - fee);
    const pnl = sh ? (pos.entry - fill) * q : (fill - pos.entry) * q;
    eq += pnl;
    if (frac < 1) { pos.base -= q; (pos.done = pos.done || []).push(level); pos.banked = (pos.banked || 0) + pnl; return; }
    const tot = pnl + (pos.banked || 0);
    trades.push({ side: pos.side, entry: pos.entry, exit: fill, pnl: tot, r: pos.risk ? tot / pos.risk : null, reason, bars: i - pos.i0 });
    consec = tot < 0 ? consec + 1 : 0; cool = i + cfg.cooldownCandles; pos = null;
  };
  for (let i = 2; i < bars.length; i++) {
    const cs = bars.slice(0, i), b = bars[i], ctx = ctxFrom(cs, null);
    if (pos) {
      const sh = pos.side === 'SHORT', mg = sh ? manageShort : manage;
      let m = mg(pos, sh ? b.high : b.low, cs, cfg, ctx); pos.stop = m.stop;
      if (m.exit && m.reason === 'stop') { close(i, sh ? Math.max(b.open, pos.stop) : Math.min(b.open, pos.stop), 'stop'); }
      else {
        m = mg(pos, sh ? b.low : b.high, cs, cfg, ctx); pos.stop = m.stop;
        if (m.partial && pos.base > 0) { const lv = (cfg.tpLadder && cfg.tpLadder.length ? cfg.tpLadder[m.level] : { r: 1 }).r, d = Math.abs(pos.entry - pos.stop0) * lv; close(i, sh ? pos.entry - d : pos.entry + d, 'partial', m.partial, m.level); }
        if (pos && m.exit && m.reason === 'take-profit') close(i, pos.target, 'take-profit');
        else if (pos) { const m2 = mg(pos, b.close, bars.slice(0, i + 1), cfg, ctx); pos.stop = m2.stop; if (m2.exit) close(i, b.close, m2.reason); }
      }
    } else if (i > cool) {
      const last = cs[cs.length - 1], scale = riskScale(consec, cfg);
      if (b.high > last.high) {
        const px = Math.max(last.high * (1 + 1e-6), b.open), sig = entrySignal(cs, px, cfg, ctx);
        if (sig.enter) {
          const spend = sizeQuote(eq, eq, sig.stopPct, cfg, scale), f = px * (1 + fee);
          if (spend > eq * 0.002) {
            pos = { side: 'LONG', base0: spend / f, base: spend / f, entry: f, stop: sig.stop, stop0: sig.stop, target: sig.target, entryCandleT: b.t, i0: i, risk: Math.abs(f - sig.stop) * (spend / f) };
            if (b.low <= pos.stop) close(i, pos.stop, 'stop');
          }
        }
      } else if (opt.short && b.low < last.low) {
        const px = Math.min(last.low * (1 - 1e-6), b.open), sig = shortSignal(cs, px, cfg, ctx);
        if (sig.enter) {
          const q = sizeShortBase(eq, px, sig.stop, eq / px, cfg, scale), f = px * (1 - fee);
          if (q * px > eq * 0.002) {
            pos = { side: 'SHORT', base0: q, base: q, entry: f, stop: sig.stop, stop0: sig.stop, target: sig.target, entryCandleT: b.t, i0: i, risk: Math.abs(sig.stop - f) * q };
            if (b.high >= pos.stop) close(i, pos.stop, 'stop');
          }
        }
      }
    }
    peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak * 100); curve.push(eq);
  }
  const w = trades.filter(t => t.pnl > 0), l = trades.filter(t => t.pnl <= 0), gp = w.reduce((a, t) => a + t.pnl, 0), gl = -l.reduce((a, t) => a + t.pnl, 0);
  return { trades, curve, net: eq - start, ret: (eq - start) / start * 100, n: trades.length, wr: trades.length ? w.length / trades.length * 100 : 0, pf: gl ? gp / gl : (gp ? Infinity : 0), mdd };
}
// Optimiser with a walk-forward split: tune on the first 70%, report the untouched last 30%.
function optimize(bars, cfgIn, opt = {}) {
  const grid = [];
  for (const maxStopPct of [1.5, 2, 3]) for (const takeProfitR of [0, 1.5, 2, 3]) for (const stopBufferPct of [0.1, 0.3]) for (const minER of [0, 0.25, 0.4]) grid.push({ maxStopPct, takeProfitR, stopBufferPct, minER });
  const cut = Math.floor(bars.length * 0.7), train = bars.slice(0, cut), test = bars.slice(cut - 25 > 0 ? cut - 25 : 0);
  const rows = grid.map(g => { const r = backtest(train, { ...cfgIn, ...g }, opt); const score = r.n >= 6 ? (Math.min(r.pf, 5) - 1) * Math.sqrt(r.n) - r.mdd / 20 : -99; return { g, r, score }; })
    .filter(x => x.score > -99).sort((a, b) => b.score - a.score).slice(0, 5)
    .map(x => ({ ...x, oos: backtest(test, { ...cfgIn, ...x.g }, opt) }));
  return { rows, base: backtest(bars, cfgIn, opt), baseTest: backtest(test, cfgIn, opt), trainN: train.length, testN: test.length };
}

module.exports = { DEFAULTS, trend, atrOf, efficiency, ctxFrom, entrySignal, shortSignal, riskScale, sizeQuote, sizeShortBase, manage, manageShort, Candles, buildCandles, aggregate, backtest, optimize };
