'use strict';
// TRENDBOT: trend bot + local control UI for XRPL mainnet (any XRP/token or token/token pair with a pool or book).
//   node bot.js                 -> UI at http://127.0.0.1:8787, paper mode until a wallet is imported
//   BOT_SEED=sEd... node bot.js -> starts with that wallet connected (live)
// The seed lives ONLY in memory (env var or the Wallet page import). It is never written to disk or logged.
// The UI/API listens on 127.0.0.1 only.
const fs = require('fs');
const path = require('path');
const http = require('http');
const xrpl = require('xrpl');
const S = require('./strategy');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const MOCK = process.env.TB_MOCK === '1'; // offline smoke test: synthetic prices, no XRPL connection
const PORT = +process.env.PORT || cfg.uiPort || 8787;
const F = n => path.join(__dirname, n);
const IOC = 0x00020000;
const XRP = { currency: 'XRP' };
const RLUSD = { currency: cfg.rlusd.currency, issuer: cfg.rlusd.issuer };
const isXRP = a => a.currency === 'XRP';
const hex = s => (s.length === 3 || s.length === 40 ? s.toUpperCase() : Buffer.from(s, 'ascii').toString('hex').toUpperCase().padEnd(40, '0'));
const sym = c => {
  if (c.length !== 40) return c;
  const s = Buffer.from(c, 'hex').toString('ascii').replace(/\0+$/, '');
  return /^[\x20-\x7e]+$/.test(s) ? s : c.slice(0, 8) + '…';
};
const asset = a => (isXRP(a) ? { currency: 'XRP' } : { currency: a.currency, issuer: a.issuer });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- pairs ----------
let pairs = [{ id: 'XRP/RLUSD', base: XRP, quote: RLUSD }];
const GHBTC = { currency: 'BTC', issuer: 'rchGBxcD1A1C2tdxF6papQYZ8kjRKMYcL' }; // GateHub BTC
pairs.push({ id: 'BTC/XRP', base: GHBTC, quote: XRP });
try { for (const p of JSON.parse(fs.readFileSync(F('pairs.json'), 'utf8'))) if (!pairs.some(x => x.id === p.id)) pairs.push(p); } catch {}
const pairById = id => pairs.find(p => p.id === id);

// ---------- state ----------
let wallet = null, client = null, busy = false;
let state = (() => { try { return JSON.parse(fs.readFileSync(F('state.json'), 'utf8')); } catch { return {}; } })();
// ---- permanent analytics store: history.json (+ rolling backup). Never reset by Resume, restarts, or deleting state.json ----
let hist = (() => { for (const f of ['history.json', 'history.bak.json']) { try { const h = JSON.parse(fs.readFileSync(F(f), 'utf8')); if (h && Array.isArray(h.trades)) return h; } catch {} } return {}; })();
hist.trades ||= []; hist.eq ||= []; hist.base ||= {}; hist.since ||= Date.now();
state.trades ||= [];
{ const kT = t => `${t.t}|${t.pair}|${t.side}|${t.entry}`, seen = new Set(state.trades.map(kT)); for (const t of hist.trades) if (!seen.has(kT(t))) state.trades.push(t); state.trades.sort((a, b) => a.t - b.t); hist.trades = state.trades.slice(); }
const tradeLimit = (pid) => 3 * Math.max(10, (hist.base[pid] || {}).eq || 0, (() => { try { return last.eqAll || 0; } catch { return 0; } })());
function purgeTrades(match) { const n0 = state.trades.length, keep = t => !match(t); state.trades = state.trades.filter(keep); hist.trades = hist.trades.filter(keep); return n0 - state.trades.length; }
{ const n = purgeTrades(t => typeof t.pnl !== 'number' || !isFinite(t.pnl) || Math.abs(t.pnl) > tradeLimit(t.pair)); if (n) console.log(`removed ${n} impossible trade(s) from analytics (P/L larger than 3x the account)`); }
let histAt = 0, bakAt = 0;
function saveHist(force) {
  if (!force && Date.now() - histAt < 20000) return; histAt = Date.now();
  try {
    if (hist.eq.length > 30000) hist.eq = hist.eq.filter((_, i) => i % 2 === 0 || i > 15000);
    if (Date.now() - bakAt > 600000 && fs.existsSync(F('history.json'))) { fs.copyFileSync(F('history.json'), F('history.bak.json')); bakAt = Date.now(); }
    fs.writeFileSync(F('history.json') + '.tmp', JSON.stringify(hist)); fs.renameSync(F('history.json') + '.tmp', F('history.json'));
  } catch (e) { log('history save failed:', e.message); }
}
const { Brain } = require('./brain');
const brain = new Brain(); state.brain ||= {}; brain.acfg = state.brain.acfg || {}; brain.lastTune = state.brain.lastTune || null; brain.hits = state.brain.hits || {};
brain.rebuild(hist.trades.filter(t => true));
state.pairId ||= 'XRP/RLUSD'; state.active = (Array.isArray(state.active) && state.active.length ? state.active : [state.pairId]).filter(id => pairs.some(p => p.id === id)); state.autoOn ??= true; state.shortOn ??= !!cfg.autoShort; state.pairs ||= {}; state.trades ||= [];
let pair = pairById(state.pairId) || pairs[0];
let P, candles; // per-pair runtime
const logs = []; const eq = []; let startEq = null, dayKey = null;
const addLog = (type, msg) => { logs.unshift({ type, msg, time: Date.now() }); if (logs.length > 80) logs.pop(); log(msg); };

function loadPair() {
  P = state.pairs[pair.id] ||= { closed: [], cur: null, pos: null, cooldownUntil: 0, consec: 0, paper: { base: 0, quote: 1000 } };
  P.ticks ||= [];
  candles = P.ticks.length > 2 ? S.buildCandles(P.ticks, cfg.timeframeMinutes) : new S.Candles(cfg.timeframeMinutes, P.closed, P.cur);
  eq.length = 0; startEq = null;
  if (typeof backfill === 'function' && client !== undefined) backfill();
}
// Seed the chart with ~16h of 1-minute history (XRP/USD, Bitstamp public API) so it isn't empty at start. XRP/RLUSD only; other pairs build live from ticks.
async function backfill() {
  const P0 = P, pid = pair.id;
  if (MOCK || pid !== 'XRP/RLUSD' || P0.ticks.length > 200) return;
  try {
    const r = await fetch('https://www.bitstamp.net/api/v2/ohlc/xrpusd/?step=60&limit=1000');
    const j = await r.json(), bars = (j.data && j.data.ohlc) || [];
    const first = P0.ticks.length ? P0.ticks[0][0] : Infinity, h = [];
    for (const b of bars) {
      const t = +b.timestamp * 1000; if (t >= first) continue;
      const o = +b.open, hi = +b.high, lo = +b.low, c = +b.close, up = c >= o;
      h.push([t, o], [t + 15000, up ? lo : hi], [t + 30000, up ? hi : lo], [t + 45000, c]);
    }
    if (h.length < 100 || P !== P0) return;
    P0.ticks = h.concat(P0.ticks); candles = S.buildCandles(P0.ticks, cfg.timeframeMinutes);
    addLog('info', `chart seeded with ${bars.length} minutes of XRP history`);
  } catch (e) { log('history backfill skipped:', e.message); }
}
function save() {
  if (P.ticks.length > 8000) P.ticks.splice(0, P.ticks.length - 6000);
  P.closed = candles.closed; P.cur = candles.cur; state.pairId = viewPair || pair.id;
  state.brain = { acfg: brain.acfg, lastTune: brain.lastTune, hits: brain.hits };
  fs.writeFileSync(F('state.json') + '.tmp', JSON.stringify(state));
  fs.renameSync(F('state.json') + '.tmp', F('state.json'));
}
function logTrade(row) {
  if (!fs.existsSync(F('trades.csv'))) fs.writeFileSync(F('trades.csv'), 'time,pair,side,mode,reason,base,quote,price,pnl_quote\n');
  fs.appendFileSync(F('trades.csv'), row.join(',') + '\n');
}

// ---------- ledger reads ----------
const amt = x => (typeof x === 'string' ? { cur: 'XRP', v: Number(x) / 1e6 } : { cur: x.currency, v: Number(x.value) });
async function ammInfo(p) {
  const r = await client.request({ command: 'amm_info', asset: asset(p.base), asset2: asset(p.quote) });
  const a = amt(r.result.amm.amount), b = amt(r.result.amm.amount2);
  const [bs, qs] = a.cur === p.base.currency ? [a, b] : [b, a];
  return { spot: qs.v / bs.v, fee: (r.result.amm.trading_fee || 0) / 100000 };
}
// Depth-weighted book price: a dust offer on top must not set the price, so average across offers until REF units of the quote are covered.
function walk(offers, getsIsBase, ref) {
  let g = 0, pz = 0;
  for (const o of offers) {
    const G = amt(o.taker_gets_funded || o.TakerGets), Pz = amt(o.taker_pays_funded || o.TakerPays);
    if (!(G.v > 0 && Pz.v > 0)) continue;
    const quoteSide = getsIsBase ? Pz.v : G.v, have = getsIsBase ? pz : g, take = Math.min(1, Math.max(0, (ref - have) / quoteSide));
    if (take <= 0) break; g += G.v * take; pz += Pz.v * take;
    if ((getsIsBase ? pz : g) >= ref * 0.999) break;
  }
  if (!(g > 0 && pz > 0)) return null;
  return getsIsBase ? pz / g : g / pz; // quote per base
}
async function bookBest(p) {
  const ref = Math.max(cfg.priceRefQuote || 100, 1);
  const [asks, bids] = await Promise.all([
    client.request({ command: 'book_offers', taker_gets: asset(p.base), taker_pays: asset(p.quote), limit: 20 }),
    client.request({ command: 'book_offers', taker_gets: asset(p.quote), taker_pays: asset(p.base), limit: 20 }),
  ]);
  const a = asks.result.offers, b = bids.result.offers;
  const depth = (offers, getsIsBase) => { if (!offers.length) return 0; const f = o => { const G = amt(o.taker_gets_funded || o.TakerGets), Pz = amt(o.taker_pays_funded || o.TakerPays); return { G: G.v, Pz: Pz.v, px: getsIsBase ? Pz.v / G.v : G.v / Pz.v }; }, best = f(offers[0]).px; let q = 0;
    for (const o of offers) { const x = f(o); if (!(x.G > 0 && x.Pz > 0)) continue; if (getsIsBase ? x.px <= best * 1.005 : x.px >= best * 0.995) q += getsIsBase ? x.Pz : x.G; } return q; };
  return { ask: walk(a, true, ref), bid: walk(b, false, ref), nA: a.length, nB: b.length, depthAsk: depth(a, true), depthBid: depth(b, false) };
}
// Real DEX trades: book_changes returns per-ledger OHLC for every book (AMM + order book fills). Used to catch wicks between polls.
// Field formats vary by server, so every candidate scaling is checked against the executable mid and only accepted within 5%.
async function dexWicks(p, mid) {
  if (MOCK || !client) return;
  const r = await client.request({ command: 'book_changes', ledger_index: 'validated' });
  const L = r.result.ledger_index; if (L === last.bcLedger) return; last.bcLedger = L;
  const want = [p.base, p.quote].map(a => isXRP(a) ? 'XRP' : a.issuer);
  const e = (r.result.changes || []).find(c => { const k = String(c.currency_a) + '|' + String(c.currency_b); return want.every(w => k.includes(w)); });
  if (!e) return;
  const near = v => { for (const f of [x => x, x => 1 / x, x => x * 1e6, x => x / 1e6, x => 1e6 / x, x => 1 / x / 1e6]) { const y = f(+v); if (isFinite(y) && y > 0 && Math.abs(y - mid) / mid < 0.05) return y; } return null; };
  const hi = near(e.high), lo = near(e.low), cl = near(e.close);
  const vals = [lo, hi, cl].filter(v => v), now = Date.now();
  if (!vals.length) return;
  for (const v of vals) { P.ticks.push([now, v]); candles.push(now, v); }
  last.dexVol = e.volume_a || e.volume_b || null; last.dexAt = now; last.dexN = (last.dexN || 0) + 1;
}
let mockPx = {};
// Executable mid: best ask = min(book ask, AMM ask), best bid = max(book bid, AMM bid). Moves with every book update, not just AMM swaps.
async function price() {
  if (MOCK) { mockPx[pair.id] = (mockPx[pair.id] || 2) * (1 + (Math.random() - 0.495) * 0.004); return mockPx[pair.id]; }
  const [amm, bk] = await Promise.allSettled([ammInfo(pair), bookBest(pair)]);
  const A = amm.status === 'fulfilled' ? amm.value : null, B = bk.status === 'fulfilled' ? bk.value : null;
  let ask = null, bid = null;
  if (A) { ask = A.spot / (1 - A.fee); bid = A.spot * (1 - A.fee); }
  if (B && B.ask) ask = ask ? Math.min(ask, B.ask) : B.ask;
  if (B && B.bid) bid = bid ? Math.max(bid, B.bid) : B.bid;
  if (A && B && B.ask && B.bid) { const m = (B.ask + B.bid) / 2; if (Math.abs(A.spot - m) / A.spot > 0.05) throw new Error(`AMM ${A.spot} and book ${m} disagree >5%, skipping tick`); }
  let v = ask && bid && bid < ask ? (ask + bid) / 2 : (A ? A.spot : (ask || bid));
  if (!v || !isFinite(v)) throw new Error('no price for ' + pair.id);
  last.ask = ask; last.bid = bid; last.src = { amm: A ? A.spot : null, bookAsk: B ? B.ask : null, bookBid: B ? B.bid : null, nA: B ? B.nA : 0, nB: B ? B.nB : 0, depthAsk: B ? B.depthAsk : 0, depthBid: B ? B.depthBid : 0 }; last.priceAt = Date.now();
  return v;
}
async function walletData() {
  const [info, lines, srv, offers] = await Promise.all([
    client.request({ command: 'account_info', account: wallet.address, ledger_index: 'current' }),
    client.request({ command: 'account_lines', account: wallet.address, ledger_index: 'current', limit: 400 }),
    client.request({ command: 'server_info' }),
    client.request({ command: 'account_offers', account: wallet.address, limit: 50 }),
  ]);
  const vl = srv.result.info.validated_ledger || {}, owner = info.result.account_data.OwnerCount || 0, rb = Number(vl.reserve_base_xrp ?? 1), ri = Number(vl.reserve_inc_xrp ?? 0.2);
  const reserve = rb + ri * owner;
  const bal = Number(info.result.account_data.Balance) / 1e6;
  return {
    address: wallet.address, xrp: bal, reserve, reserveBase: rb, reserveInc: ri, spendable: Math.max(0, bal - reserve - cfg.xrpReserveBuffer), owner,
    lines: lines.result.lines.map(l => ({ currency: sym(l.currency), raw: l.currency, issuer: l.account, balance: Number(l.balance), limit: Number(l.limit) })),
    offers: offers.result.offers.length,
  };
}
async function walletTx() {
  const r = await client.request({ command: 'account_tx', account: wallet.address, limit: 12 });
  return r.result.transactions.map(t => {
    const tx = t.tx_json || t.tx || {};
    return { type: tx.TransactionType, hash: t.hash || tx.hash, result: (t.meta || {}).TransactionResult, date: tx.date ? (tx.date + 946684800) * 1000 : null };
  });
}
async function balances() {
  if (!wallet) return { base: P.paper.base, quote: P.paper.quote };
  if (MOCK) return { base: 0, quote: 0 };
  const w = await walletData(); walC = w; walAt = Date.now();
  const get = a => {
    if (isXRP(a)) return w.spendable;
    const l = w.lines.find(x => x.raw === a.currency && x.issuer === a.issuer);
    if (!l) { last.noTrust = `No trust line for ${sym(a.currency)} on this wallet: add it on the Wallet page (Receive / trust line).`; return 0; }
    last.noTrust = null; return l.balance;
  };
  return { base: get(pair.base), quote: get(pair.quote) };
}

// ---------- execution ----------
let txQ = Promise.resolve();
const sub = (tx, opts) => { const run = () => client.submitAndWait(tx, opts); const p = txQ.then(run, run); txQ = p.catch(() => {}); return p; }; // one transaction at a time: no sequence clashes between a cancel and a tick's order
const amount = (a, v) => (isXRP(a) ? xrpl.xrpToDrops(Number(v).toFixed(6)) : { currency: a.currency, issuer: a.issuer, value: Number(v).toPrecision(12) });
async function swap(side, amountIn, px, slipPct) {
  balAt = 0;
  if (!wallet) { // paper fill
    const p = side === 'BUY' ? px * (1 + slipPct / 200) : px * (1 - slipPct / 200);
    if (side === 'BUY') { P.paper.quote -= amountIn; P.paper.base += amountIn / p; return { filled: true, base: amountIn / p, quote: amountIn, price: p }; }
    P.paper.base -= amountIn; P.paper.quote += amountIn * p; return { filled: true, base: amountIn, quote: amountIn * p, price: p };
  }
  let gets, pays;
  if (side === 'BUY') { gets = amount(pair.quote, amountIn); pays = amount(pair.base, amountIn / (px * (1 + slipPct / 100))); }
  else { gets = amount(pair.base, amountIn); pays = amount(pair.quote, amountIn * px * (1 - slipPct / 100)); }
  const before = await balances();
  const res = await sub({ TransactionType: 'OfferCreate', Account: wallet.address, TakerGets: gets, TakerPays: pays, Flags: IOC }, { wallet, autofill: true });
  const code = res.result.meta.TransactionResult;
  const fee = Number(res.result.Fee || 0) / 1e6;
  // exact fill from this transaction's own metadata, so another pair's trades/resting orders on the shared wallet can't distort it; balance deltas only as a fallback
  const mc = (() => { try { const c = xrpl.getBalanceChanges(res.result.meta).find(x => x.account === wallet.address); return c ? c.balances : []; } catch { return []; } })();
  const pick = a => { const r = mc.find(x => (isXRP(a) ? x.currency === 'XRP' : x.currency === a.currency && x.issuer === a.issuer)); return r ? Number(r.value) : null; };
  const mB = pick(pair.base), mQ = pick(pair.quote);
  let dB, dQ;
  if (mc.length) { dB = (mB ?? 0) + (isXRP(pair.base) ? fee : 0); dQ = (mQ ?? 0) + (isXRP(pair.quote) ? fee : 0); }
  else { await sleep(1500); const after = await balances(); dB = after.base - before.base + (isXRP(pair.base) ? fee : 0); dQ = after.quote - before.quote + (isXRP(pair.quote) ? fee : 0); }
  if (code !== 'tesSUCCESS' || Math.abs(dQ) < 1e-9) return { filled: false, code };
  const fp = Math.abs(dQ) / Math.abs(dB); brain.recordSlip((side === 'BUY' ? fp / px - 1 : 1 - fp / px) * 100);
  return { filled: true, code, base: Math.abs(dB), quote: Math.abs(dQ), price: fp };
}

async function openPos(px, stop, target, spendQuote, why) {
  const r = await swap('BUY', spendQuote, px, cfg.smart !== false ? brain.slipPct(cfg) : cfg.entrySlippagePct);
  if (!r.filled) { addLog('info', `BUY not filled (${r.code})`); return false; }
  P.pos = { side: 'LONG', base: r.base, cost: r.quote, entry: r.price, stop, target, userStop: false, entryCandleT: candles.cur.t, risk: Math.abs(r.price - stop) * r.base, t0: Date.now(), stop0: stop, base0: r.base, done: [], ov: P.nextOv || null, reg: P.nextReg || null };
  P.nextOv = P.nextReg = null;
  P.tradesToday = (P.tradesToday || 0) + 1;
  (P.marks ||= []).push({ t: candles.cur.t, price: r.price, kind: 'buy' }); if (P.marks.length > 200) P.marks.shift();
  logTrade([new Date().toISOString(), pair.id, 'BUY', wallet ? 'live' : 'paper', why, r.base.toFixed(6), r.quote.toFixed(6), r.price.toPrecision(8), '']);
  addLog('buy', `BUY ${r.base.toFixed(2)} ${sym(pair.base.currency)} @ ${r.price.toPrecision(6)} · stop ${stop.toPrecision(6)}`);
  return true;
}
async function openShort(px, stop, target, qtyBase, why) {
  const r = await swap('SELL', qtyBase, px, cfg.smart !== false ? brain.slipPct(cfg) : cfg.entrySlippagePct);
  if (!r.filled) { addLog('info', `SHORT not filled (${r.code})`); return false; }
  P.pos = { side: 'SHORT', base: r.base, cost: r.quote, entry: r.price, stop, target, userStop: false, entryCandleT: candles.cur.t, risk: Math.abs(stop - r.price) * r.base, t0: Date.now(), stop0: stop, base0: r.base, done: [], ov: P.nextOv || null, reg: P.nextReg || null };
  P.nextOv = P.nextReg = null;
  P.tradesToday = (P.tradesToday || 0) + 1;
  (P.marks ||= []).push({ t: candles.cur.t, price: r.price, kind: 'short' }); if (P.marks.length > 200) P.marks.shift();
  logTrade([new Date().toISOString(), pair.id, 'SHORT', wallet ? 'live' : 'paper', why, r.base.toFixed(6), r.quote.toFixed(6), r.price.toPrecision(8), '']);
  addLog('sell', `SHORT (sold ${r.base.toFixed(2)} ${sym(pair.base.currency)}) @ ${r.price.toPrecision(6)} · stop ${stop.toPrecision(6)}`);
  return true;
}
const pauseAuto = () => { P.cooldownUntil = Math.max(P.cooldownUntil || 0, Date.now() + (cfg.manualPauseCandles ?? 3) * cfg.timeframeMinutes * 60000); };
async function closeAll(reason) { // manual exit: keeps retrying with wider slippage until flat, and stops the bot from instantly re-entering
  let slip = cfg.stopSlippagePct, tries = 0, lastErr = '';
  while (P.pos && tries < 5) { tries++; const px = await price(); try { await closePos(px, reason, slip); } catch (e) { lastErr = e.message; addLog('info', 'close attempt failed: ' + e.message); } if (P.pos) slip = Math.min(slip * 2, 15); }
  pauseAuto();
  if (P.pos) throw new Error('Could not close after ' + tries + ' tries' + (lastErr ? ': ' + lastErr : ' (no fill: check liquidity on the pair)'));
}
async function closePos(px, reason, slip, frac = 1) {
  const pos = P.pos, short = pos.side === 'SHORT';
  if (pos.tp) { await cancelOffer(pos.tp.seq); pos.tp = null; }
  let r;
  if (short) { // buy back the base we sold
    const b = await balances();
    const spend = Math.min(pos.base * frac * px * (1 + slip / 100), b.quote);
    r = await swap('BUY', spend, px, slip);
  } else {
    const b = await balances();
    const qty = Math.min(pos.base * frac, isXRP(pair.base) ? Math.max(b.base, 0) : b.base);
    r = await swap('SELL', qty, px, slip);
  }
  if (!r.filled) { addLog('info', `exit not filled (${r.code}); retrying next tick`); return false; }
  recordExit(r.base, r.quote, r.price, reason);
  return true;
}

function recordExit(rBase, rQuote, rPrice, reason) {
  const pos = P.pos, short = pos.side === 'SHORT';
  // a cover IOC can buy slightly more than was owed (slippage headroom): count only the owed base, the surplus is just inventory
  if (short && rBase > pos.base * 1.0000001) { rQuote = rQuote * pos.base / rBase; rBase = pos.base; }
  const portion = Math.min(1, rBase / pos.base);
  const pnl = short ? pos.cost * portion - rQuote : rQuote - pos.cost * portion;
  if (!isFinite(pnl) || Math.abs(pnl) > tradeLimit(pair.id)) { addLog('info', `exit P/L ${pnl} looks impossible for this account: not counted in analytics`); P.pos = null; return; }
  P.dayPnl = (P.dayPnl || 0) + pnl;
  if (pnl < 0 && /stop/.test(reason)) P.lastStop = { t: Date.now(), long: !short };
  pos.cost -= pos.cost * portion; pos.base -= rBase;
  state.trades.push({ t: Date.now(), pair: pair.id, side: short ? 'SHORT' : 'LONG', entry: pos.entry, exit: rPrice, pnl: +pnl.toFixed(6), r: pos.risk ? +(pnl / (pos.risk * portion)).toFixed(3) : null, reg: pos.reg || null, reason, bars: pos.t0 ? Math.max(0, Math.round((Date.now() - pos.t0) / candles.tf)) : 0 }); if (state.trades.length > 500) state.trades.shift();
  hist.trades.push(state.trades[state.trades.length - 1]); brain.learn(state.trades[state.trades.length - 1]); saveHist(true);
  (P.marks ||= []).push({ t: candles.cur.t, price: rPrice, kind: short ? 'cover' : 'sell' });
  logTrade([new Date().toISOString(), pair.id, short ? 'COVER' : 'SELL', wallet ? 'live' : 'paper', reason, rBase.toFixed(6), rQuote.toFixed(6), rPrice.toPrecision(8), pnl.toFixed(6)]);
  addLog(pnl < 0 ? 'loss' : 'sell', `${short ? 'COVER' : 'SELL'} ${rBase.toFixed(2)} @ ${rPrice.toPrecision(6)} · ${reason} · ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} ${sym(pair.quote.currency)}`);
  if (pos.base < 1e-6 || pos.base * rPrice < Math.max(1e-6, cfg.minTradeQuote * 0.1) || (short && portion > 0.98)) { P.consec = pnl < 0 ? P.consec + 1 : 0; P.cooldownUntil = reason === 'trend-flip' && cfg.flipReverse ? 0 : (candles.cur?.t || Date.now()) + cfg.cooldownCandles * cfg.timeframeMinutes * 60_000; P.pos = null; }
}

// ---------- automatic limit orders: entries rest on the book, take-profit rests on the book, stops are polled ----------
async function placeLimit(side, baseAmt, price) {
  const qa = baseAmt * price;
  const gets = side === 'BUY' ? amount(pair.quote, qa) : amount(pair.base, baseAmt), pays = side === 'BUY' ? amount(pair.base, baseAmt) : amount(pair.quote, qa);
  const before = new Set(offC.map(o => o.seq));
  const res = await sub({ TransactionType: 'OfferCreate', Account: wallet.address, TakerGets: gets, TakerPays: pays }, { wallet, autofill: true });
  const code = res.result.meta.TransactionResult; if (code !== 'tesSUCCESS') throw new Error('limit order rejected: ' + code);
  let seq = (res.result.tx_json || {}).Sequence ?? res.result.Sequence;
  if (!seq) { await refreshOffers(true); const n = offC.find(o => !before.has(o.seq)); seq = n && n.seq; }
  offAt = 0; balAt = 0; return seq || null;
}
async function cancelOffer(seq) {
  if (!seq) return;
  try { await sub({ TransactionType: 'OfferCancel', Account: wallet.address, OfferSequence: seq }, { wallet, autofill: true }); } catch (e) { log('cancel', seq, e.message); }
  offAt = 0; balAt = 0;
}
function makePos(side, base, quote, entry, stop, target, why) {
  const sh = side === 'SHORT';
  P.pos = { side, base, cost: quote, entry, stop, target, userStop: false, entryCandleT: candles.cur.t, risk: Math.abs(entry - stop) * base, t0: Date.now(), stop0: stop, base0: base, done: [], ov: P.nextOv || null, reg: P.nextReg || null };
  P.nextOv = P.nextReg = null;
  P.tradesToday = (P.tradesToday || 0) + 1;
  (P.marks ||= []).push({ t: candles.cur.t, price: entry, kind: sh ? 'short' : 'buy' }); if (P.marks.length > 200) P.marks.shift();
  logTrade([new Date().toISOString(), pair.id, sh ? 'SHORT' : 'BUY', wallet ? 'live' : 'paper', why, base.toFixed(6), quote.toFixed(6), entry.toPrecision(8), '']);
  addLog(sh ? 'sell' : 'buy', `${sh ? 'SHORT (sold ' : 'BUY ('}${base.toFixed(2)} ${sym(pair.base.currency)}) @ ${entry.toPrecision(6)} · stop ${stop.toPrecision(6)}${target ? ' · target ' + target.toPrecision(6) : ''}`);
}
// automatic stop-loss / take-profit from % of entry (slPct / tpPct), overriding structure stops when set
function autoLv(sg, px, long) {
  let stop = sg.stop, target = sg.target, stopPct = sg.stopPct;
  if (cfg.slPct > 0) { stop = long ? px * (1 - cfg.slPct / 100) : px * (1 + cfg.slPct / 100); stopPct = cfg.slPct; }
  if (cfg.tpPct > 0) target = long ? px * (1 + cfg.tpPct / 100) : px * (1 - cfg.tpPct / 100);
  return { stop, target, stopPct };
}
// f: 0 = best bid (patient maker), 1 = best ask (marketable). The bot starts patient and walks the price toward the other side until filled.
function limitPx(long, px, f) { const bid = last.bid, ask = last.ask; return bid && ask && bid < ask ? (long ? bid + f * (ask - bid) : ask - f * (ask - bid)) : (long ? px * (1 - 0.0004 + 0.0006 * f) : px * (1 + 0.0004 - 0.0006 * f)); }
async function openLimit(long, px, stop, target, amt, why) {
  const f0 = Math.min(1, Math.max(0, cfg.smart !== false ? brain.limitFrac(cfg) : (cfg.limitSpreadFrac ?? 0.3)));
  const lp = limitPx(long, px, f0);
  const baseAmt = long ? amt / lp : amt;
  if (baseAmt * lp < cfg.minTradeQuote) return false;
  const pre = await balances(); balC = pre; balAt = Date.now();
  const seq = await placeLimit(long ? 'BUY' : 'SELL', baseAmt, lp);
  P.pend = { long, seq, price: lp, base: baseAmt, stop, target, why, t0: Date.now(), pre, sigPx: px, lastRe: Date.now(), f0 };
  addLog('info', `LIMIT ${long ? 'BUY' : 'SELL-SHORT'} ${baseAmt.toFixed(4)} ${sym(pair.base.currency)} @ ${lp.toPrecision(6)} resting on the book (timeout ${cfg.limitTimeoutSec}s)`);
  return true;
}
function brainSnap() { const src = last.src || {}; return { ask: last.ask, bid: last.bid, amm: src.amm, bookBid: src.bookBid, bookAsk: src.bookAsk, depthAsk: src.depthAsk, depthBid: src.depthBid, refDev: (last.ref && last.px && pair.id.startsWith('XRP/')) ? (last.px / last.ref - 1) * 100 : null, tickAgeMs: last.priceAt ? Date.now() - last.priceAt : 0, ledgerAgeMs: last.ledgerAt ? Date.now() - last.ledgerAt : 0 }; }
const ecfg = () => (cfg.smart !== false ? { ...cfg, ...brain.acfg } : cfg);
let lastVeto = '', lastVetoAt = 0;
async function enter(long, px, stop, target, amt, why) {
  if (!tradeOK) return false;
  if (cfg.smart !== false) {
    const d = brain.evaluate({ long, px, stop, closed: candles.closed, cfg, snap: brainSnap(), sess: { consec: P.consec || 0, ddPct: last.ddPct || 0 }, relaxed: /^always-in/.test(why), orderQuote: long ? amt : amt * px });
    if (!d.ok) { if (d.why !== lastVeto || Date.now() - lastVetoAt > 60000) { lastVeto = d.why; lastVetoAt = Date.now(); addLog('info', `SMART skipped ${long ? 'long' : 'short'}: ${d.why}`); } return false; }
    const avail = balC ? (long ? balC.quote : balC.base) : Infinity; amt = Math.min(amt * d.size, avail * 0.98);
    if ((long ? amt : amt * px) < cfg.minTradeQuote) return false;
    P.nextOv = d.ov; P.nextReg = d.reg; why = why + ` [smart ${d.reg} ${Math.round(d.score)} x${d.size.toFixed(2)}]`;
  } else { P.nextOv = null; P.nextReg = null; }
  if (cfg.entryMode === 'limit' && wallet && !MOCK && client) { try { return await openLimit(long, px, stop, target, amt, why); } catch (e) { addLog('info', 'limit entry failed (' + e.message + '), using market order'); } }
  return long ? openPos(px, stop, target, amt, why) : openShort(px, stop, target, amt, why);
}
async function placeTp(pos) {
  if (!cfg.tpLimit || !wallet || MOCK || !client || !pos.target || (cfg.tpLadder && cfg.tpLadder.length)) return;
  try {
    const seq = await placeLimit(pos.side === 'SHORT' ? 'BUY' : 'SELL', pos.base, pos.target);
    pos.tp = { seq, left: pos.base, price: pos.target };
    addLog('info', `TAKE-PROFIT resting on the book: ${pos.side === 'SHORT' ? 'buy' : 'sell'} ${pos.base.toFixed(4)} @ ${pos.target.toPrecision(6)}`);
  } catch (e) { addLog('info', 'could not rest take-profit order: ' + e.message); }
}
async function handlePend(px, halt) {
  const o = P.pend; await refreshOffers(true);
  let live = o.seq ? offC.find(x => x.seq === o.seq) : null;
  const filled0 = o.seq ? (live ? Math.max(0, o.base - live.base) : o.base) : 0; // base filled, from the order itself (not wallet balances)
  const age = (Date.now() - o.t0) / 1000, ch = cfg.limitChasePct / 100;
  const away = o.long ? px > (o.sigPx || o.price) * (1 + ch) : px < (o.sigPx || o.price) * (1 - ch), dead = o.long ? px <= o.stop : px >= o.stop, timeout = age > cfg.limitTimeoutSec;
  let why = null;
  if (live && (halt || dead || away || timeout)) { await cancelOffer(o.seq); live = null; why = halt ? 'halt' : dead ? 'stop level hit first' : away ? 'price ran away' : 'timeout'; if (away || timeout) brain.recordFill(false); }
  if (live) { // untouched resting order: walk it toward the market
    if (!dead && live.base >= o.base * 0.999 && Date.now() - o.lastRe >= (cfg.limitRepriceSec || 4) * 1000) {
      const f = Math.min(1.1, o.f0 + (1.1 - o.f0) * Math.min(1, age / (cfg.limitTimeoutSec * 0.7))), np = limitPx(o.long, px, f);
      o.lastRe = Date.now();
      if (Math.abs(np - o.price) / o.price > 0.00005) {
        await cancelOffer(o.seq);
        try { o.seq = await placeLimit(o.long ? 'BUY' : 'SELL', o.base, np); o.price = np; } catch (e) { addLog('info', 'reprice failed: ' + e.message); o.seq = null; }
      }
    }
    return;
  }
  balAt = 0; const b = await balances(); balC = b; balAt = Date.now();
  const dBase = filled0, dQuote = filled0 * o.price;
  P.pend = null;
  if (dBase >= o.base * 0.05 && dBase * px >= cfg.minTradeQuote * 0.1) {
    const entry = dBase > 0 ? dQuote / dBase : o.price, A = autoLv({ stop: o.stop, target: o.target, stopPct: 0 }, entry, o.long); // re-anchor % stop/target to the real fill
    brain.recordFill(true);
    makePos(o.long ? 'LONG' : 'SHORT', dBase, dQuote, entry, A.stop, A.target, o.why + ' (limit)');
    await placeTp(P.pos);
  } else {
    addLog('info', `limit entry not filled${why ? ' (' + why + ')' : ''}`);
    if (why === 'price ran away' && cfg.limitFallback && !halt && state.autoOn && (cfg.alwaysIn || cfg.chaseMarket)) { // trend is running: take it at market with the same stop distance instead of missing it
      const d = px - (o.sigPx || o.price), st = o.stop + d, tg = o.target ? o.target + d : o.target, amt = o.long ? o.base * px : o.base;
      addLog('info', 'price ran away: entering at market with the stop distance preserved');
      await (o.long ? openPos(px, st, tg, amt, o.why + ' (market chase)') : openShort(px, st, tg, amt, o.why + ' (market chase)'));
    } else if (why === 'price ran away') P.cooldownUntil = Date.now() + 20000;
    if (why === 'timeout' && cfg.limitFallback && !halt && state.autoOn) { const amt = o.long ? o.base * px : o.base; await (o.long ? openPos(px, o.stop, o.target, amt, o.why + ' (market fallback)') : openShort(px, o.stop, o.target, amt, o.why + ' (market fallback)')); }
  }
}
async function manageTp(px) {
  const pos = P.pos; if (!pos || !pos.tp) return; await refreshOffers(true);
  const o = offC.find(x => x.seq === pos.tp.seq), left = o ? o.base : 0, long = pos.side !== 'SHORT', c = candles.cur;
  const reached = long ? Math.max(px, c ? c.high : px) >= pos.tp.price * 0.999 : Math.min(px, c ? c.low : px) <= pos.tp.price * 1.001;
  if (!o && !reached) { pos.tp = null; addLog('info', 'take-profit order is gone from the book (cancelled elsewhere?), software exits still active'); return; }
  const filled = pos.tp.left - left;
  if (filled > Math.max(1e-9, pos.tp.left * 1e-5)) { pos.tp.left = left; recordExit(filled, filled * pos.tp.price, pos.tp.price, 'take-profit (limit)'); }
  if (P.pos && !o) P.pos.tp = null;
}

// ---------- strategy context / allocation ----------
const mkCtx = () => S.ctxFrom(candles.closed, S.aggregate(candles.closed, candles.cur, cfg.htfMult || 4), { tradesToday: P.tradesToday || 0 });
const useFrac = () => Math.min(1, Math.max(0.05, (P.use ?? 100) / 100));
let busySince = 0, runStartEq = null, prevB = null, walC = null, walAt = 0, walTxC = [], walTxAt = 0, balC = null, balAt = 0, offC = [], offAt = 0, xuC = null, xuAt = 0;
const amtOf = x => (typeof x === 'string' ? { cur: 'XRP', v: Number(x) / 1e6, iss: null } : { cur: x.currency, v: Number(x.value), iss: x.issuer });
const isAsset = (x, a) => (isXRP(a) ? x.cur === 'XRP' : x.cur === a.currency && x.iss === a.issuer);
async function refreshOffers(force) {
  if (!wallet || MOCK || !client || (!force && Date.now() - offAt < 5000)) return; offAt = Date.now();
  const r = await client.request({ command: 'account_offers', account: wallet.address, limit: 200 });
  offC = (r.result.offers || []).map(o => { const g = amtOf(o.taker_gets), p = amtOf(o.taker_pays);
    if (isAsset(g, pair.base) && isAsset(p, pair.quote)) return { seq: o.seq, side: 'SELL', price: p.v / g.v, base: g.v, quote: p.v, passive: !!((o.flags || 0) & 0x10000) };
    if (isAsset(g, pair.quote) && isAsset(p, pair.base)) return { seq: o.seq, side: 'BUY', price: g.v / p.v, base: p.v, quote: g.v, passive: !!((o.flags || 0) & 0x10000) };
    return null; }).filter(Boolean);
}
// XRP price in RLUSD, for $ / XRP valuation of any pair
async function xuNow(px) {
  if (pair.id === 'XRP/RLUSD') return px;
  if (MOCK || !client) return xuC || 1;
  if (Date.now() - xuAt < 20000 && xuC) return xuC; xuAt = Date.now();
  try { xuC = (await ammInfo(pairById('XRP/RLUSD'))).spot; } catch {} return xuC;
}
// ---------- main tick ----------
let last = { px: null, sig: { trend: 'NONE', why: 'warming up' }, err: null };
const equityOf = (b, px) => b.quote + b.base * px;
async function tickBody() {
  try {
    const px = await price(); last.px = px; last.err = null; last.at = Date.now(); errRun = 0;
    const now = Date.now();
    try { await dexWicks(pair, px); } catch (e) { last.dexErr = e.message; }
    P.ticks.push([now, px]);
    const closedNow = candles.push(now, px);
    let b = balC; if (!(Date.now() - balAt < 3000 && balC)) { b = await balances(); balC = b; balAt = Date.now(); }
    if (wallet && !MOCK && Date.now() - walTxAt > 20000) { walTxAt = Date.now(); walletTx().then(t => { walTxC = t; }).catch(() => {}); }
    const e = equityOf(b, px);
    if (startEq == null) startEq = e;
    if (runStartEq == null) runStartEq = e;
    // external deposit/withdrawal (not a trade): shift the day's baseline by the flow so it is not read as a trading gain or loss
    if (wallet && prevB && !prevB.busy && !(P.pos || P.pend) && prevB.tr === state.trades.length && prevB.pid === pair.id) {
      const flow = (b.quote - prevB.b.quote) + (b.base - prevB.b.base) * px;
      if (Math.abs(flow) > Math.max(cfg.minTradeQuote, 0.01 * Math.max(e, 1e-9))) { startEq += flow; runStartEq += flow; if (hist.base[pair.id]) hist.base[pair.id].eq += flow; if (startEq < 0) startEq = 0; if (runStartEq < 0) runStartEq = 0; addLog('info', `Deposit/withdrawal detected: ${flow >= 0 ? '+' : ''}${flow.toFixed(4)} ${sym(pair.quote.currency)}. Baseline adjusted, P/L unchanged.`); }
    }
    prevB = { b: { ...b }, busy: !!(P.pos || P.pend), tr: state.trades.length, pid: pair.id };
    if (walC) { const tot = a => isXRP(a) ? walC.xrp : ((walC.lines.find(x => x.raw === a.currency && x.issuer === a.issuer) || {}).balance || 0); last.eqAll = tot(pair.quote) + tot(pair.base) * px; last.xrpTotal = walC.xrp;
      const ev = last.eqAll;
      if (ev > 0 && !hist.base[pair.id]) hist.base[pair.id] = { t: Date.now(), eq: ev };
      if (!hist.lastEqT || Date.now() - hist.lastEqT >= 30000) { hist.lastEqT = Date.now(); hist.eq.push([Date.now(), +ev.toFixed(6), pair.id]); saveHist(); } }
    const dk = new Date().toISOString().slice(0, 10);
    if (dk !== dayKey) { dayKey = dk; startEq = e; P.tradesToday = 0; P.dayPnl = 0; P.goalHit = false; if (state.halted && /daily goal/.test(state.halted)) state.halted = null; }
    eq.push(e); if (eq.length > 600) eq.shift();
    const unreal = P.pos ? (P.pos.side === 'SHORT' ? P.pos.cost - P.pos.base * px : P.pos.base * px - P.pos.cost) : 0;
    const tradePnlPct = ((P.dayPnl || 0) + unreal) / Math.max(1e-9, startEq * useFrac()) * 100; // trading P/L only, not idle-inventory price moves
    last.tp = tradePnlPct;
    last.eq = e; last.note = e * useFrac() < cfg.minTradeQuote * 2 ? `Wallet too small to trade: equity ${e.toFixed(3)} ${sym(pair.quote.currency)} (XRP counted only above reserve + ${cfg.xrpReserveBuffer} buffer). Needs roughly ${(cfg.minTradeQuote * 2).toFixed(0)}+ to place orders.` : null;
    try { await refreshOffers(); } catch (e) { last.offErr = e.message; }
    { const xu = await xuNow(px), qx = isXRP(pair.quote) ? 1 : (xu ? 1 / xu : null); last.fx = xu && qx ? { usd: qx * xu, xrp: qx, xu } : null; }
    const ctx = mkCtx();
    last.plan = (() => { const cl = candles.closed; if (cl.length < 2) return null; const c2 = cl[cl.length - 1], bf = cfg.stopBufferPct / 100, mx = cfg.maxStopPct / 100, R = Math.max(cfg.takeProfitR || 2, 1.5);
      const ls = Math.max(c2.low * (1 - bf), c2.high * (1 - mx)), ss2 = Math.min(c2.high * (1 + bf), c2.low * (1 + mx));
      return { long: { trigger: c2.high, stop: ls, target: c2.high + (c2.high - ls) * R }, short: { trigger: c2.low, stop: ss2, target: c2.low - (ss2 - c2.low) * R }, shortsOn: !!state.shortOn }; })();
    if (P.goal > 0 && !P.goalHit && startEq && tradePnlPct >= P.goal && cfg.runForever) { P.goalHit = true; addLog('buy', `Daily goal +${P.goal}% reached: run-forever is ON, so trading continues`); }
    if (P.goal > 0 && !P.goalHit && startEq && tradePnlPct >= P.goal) { P.goalHit = true; state.halted = `daily goal +${P.goal}% reached`; addLog('buy', 'DAILY GOAL reached: flattening, resumes tomorrow'); }
    if (state.halted && /^daily loss/.test(state.halted) && -tradePnlPct < cfg.dailyLossHaltPct) { addLog('info', `Daily-loss halt cleared: loss is now ${(-tradePnlPct).toFixed(2)}% (under ${cfg.dailyLossHaltPct}%)`); state.halted = null; }
    if (cfg.hardFloorPct > 0 && runStartEq > 0 && !state.halted && e < runStartEq * (1 - cfg.hardFloorPct / 100)) { state.halted = `hard floor: equity down ${cfg.hardFloorPct}% from the run start`; addLog('loss', 'HALT ' + state.halted + ' (press Resume to continue)'); }
    last.ddPct = Math.max(0, -tradePnlPct);
    { const n = candles.closed.length; if (cfg.smart !== false && n >= 220 && n % 150 === 0 && n !== P.retuneN) { P.retuneN = n; brain.retune(candles.closed, cfg, (a, t) => addLog('info', 'SMART re-tuned · ' + t)); } }
    const halt = fs.existsSync(F('STOP')) ? 'STOP file present' : state.halted;
    if (P.pos && !(P.pos.base > 1e-9)) { addLog('info', 'cleared empty position record'); P.pos = null; }
    if (P.pend) await handlePend(px, halt);
    if (P.pos && P.pos.tp) await manageTp(px);
    if (P.pos) {
      const m = (P.pos.side === 'SHORT' ? S.manageShort : S.manage)(P.pos, px, candles.closed, P.pos.ov ? { ...ecfg(), ...P.pos.ov } : ecfg(), ctx);
      P.pos.stop = m.stop;
      if (m.exit && m.reason === 'take-profit' && P.pos.tp) { /* resting limit handles it */ }
      else if (m.partial && !m.exit && !halt) { const q = P.pos.base0 * m.partial; if (await closePos(px, `ladder ${m.level + 1}`, cfg.entrySlippagePct, Math.min(1, q / P.pos.base))) { if (P.pos) P.pos.done.push(m.level); } }
      else if (m.exit || halt) await closePos(px, halt ? 'halt: ' + halt : m.reason, m.reason === 'take-profit' ? cfg.entrySlippagePct : cfg.stopSlippagePct);
    } else if (!P.pend) {
      const sig = S.entrySignal(candles.closed, px, cfg, ctx); last.sig = sig;
      if (closedNow) addLog('info', `candle closed H ${closedNow.high.toPrecision(6)} L ${closedNow.low.toPrecision(6)} | ${sig.why}`);
      if (!halt && state.autoOn) {
        const dd = -tradePnlPct;
        if (cfg.runForever && dd >= cfg.dailyLossHaltPct) { P.cooldownUntil = now + Math.max(3, cfg.cooldownCandles * 3) * cfg.timeframeMinutes * 60000; addLog('loss', `Daily loss ${dd.toFixed(2)}% hit the limit: run-forever pauses ${Math.max(3, cfg.cooldownCandles * 3)} candles, resets the day's baseline and continues`); startEq = e; P.dayPnl = 0; }
        else if (cfg.runForever && P.consec >= cfg.maxConsecutiveLosses) { P.cooldownUntil = now + 3 * cfg.timeframeMinutes * 60000; P.consec = Math.max(0, cfg.maxConsecutiveLosses - 1); addLog('loss', `${cfg.maxConsecutiveLosses} losses in a row: run-forever pauses 3 candles (size stays reduced) and continues`); }
        else if (dd >= cfg.dailyLossHaltPct) { state.halted = `daily loss ${dd.toFixed(2)}% hit limit`; addLog('loss', 'HALT ' + state.halted); }
        else if (P.consec >= cfg.maxConsecutiveLosses) { state.halted = `${P.consec} losses in a row`; addLog('loss', 'HALT ' + state.halted); }
        else if (now >= P.cooldownUntil && sig.enter) {
          const A = autoLv(sig, px, true), u = useFrac(), spend = S.sizeQuote(e * u, Math.min(b.quote, e * u), A.stopPct, cfg, S.riskScale(P.consec, cfg));
          if (spend >= cfg.minTradeQuote) await enter(true, px, A.stop, A.target, spend, sig.why);
          else { last.note = `SIGNAL but size ${spend.toFixed(3)} < min ${cfg.minTradeQuote} ${sym(pair.quote.currency)}: wallet too small (equity ${e.toFixed(3)}, spendable ${b.quote.toFixed(3)} ${sym(pair.quote.currency)})`; if (Date.now() - (last.noteAt || 0) > 60000) { last.noteAt = Date.now(); addLog('info', last.note); } }
        } else if (now >= P.cooldownUntil && state.shortOn) {
          const ss = S.shortSignal(candles.closed, px, cfg, ctx);
          if (ss.enter) {
            const A = autoLv(ss, px, false), u = useFrac(), qty = S.sizeShortBase(e * u, px, A.stop, b.base, cfg, S.riskScale(P.consec, cfg));
            if (qty * px >= cfg.minTradeQuote) await enter(false, px, A.stop, A.target, qty, ss.why);
          } else if (!sig.enter && sig.trend !== 'UP') last.sig = { ...sig, why: sig.why + ' · short: ' + ss.why };
        }
        // ALWAYS-IN-MARKET: if no breakout signal fired and we're flat, take the side the trend favours right now (same candle-structure stop/target).
        if (cfg.alwaysIn && !P.pos && !P.pend && !state.halted && Date.now() >= P.cooldownUntil && last.plan) {
          const cl = candles.closed, c2 = cl[cl.length - 1];
          // side vote: candle-structure trend, EMA 9/21, last-candle slope, recent tick momentum, and a penalty on the side that just stopped out
          const ema = (arr, n) => { const k = 2 / (n + 1); let v = arr[0]; for (const x of arr) v = x * k + v * (1 - k); return v; }, cs = cl.slice(-40).map(c => c.close);
          let score = (cfg.smart !== false ? brain.regimeVote(cl, px, cfg) : 0) + (sig.trend === 'UP' ? 1 : sig.trend === 'DOWN' ? -1 : 0) + (cs.length >= 21 ? (ema(cs, 9) > ema(cs, 21) ? 1 : -1) : 0) + (cl.length >= 2 ? (c2.close >= cl[cl.length - 2].close ? 0.5 : -0.5) : 0);
          const tk = P.ticks.slice(-40).map(t => t[1]); if (tk.length >= 10) score += px >= tk.reduce((a, b) => a + b, 0) / tk.length ? 0.5 : -0.5;
          if (P.lastStop && Date.now() - P.lastStop.t < cfg.timeframeMinutes * 60000 * 3) score += P.lastStop.long ? -1.5 : 1.5;
          const up = score > 0 ? true : score < 0 ? false : px >= c2.close;
          // cost guard: expected candle range must clearly exceed the round-trip spread, otherwise fees/spread eat the edge
          const spreadPct = last.ask && last.bid ? (last.ask - last.bid) / px * 100 : 0;
          if (ctx.atrPct != null && ctx.atrPct < 2 * spreadPct) { if (Date.now() - (last.noteAt || 0) > 60000) { last.noteAt = Date.now(); addLog('info', `always-in paused: range ${ctx.atrPct.toFixed(3)}% < 2x spread ${spreadPct.toFixed(3)}%`); } } else {
          const can = (long) => { const lv = long ? last.plan.long : last.plan.short, A = autoLv({ stop: lv.stop, target: lv.target, stopPct: 0 }, px, long), u = useFrac(), rs = S.riskScale(P.consec, cfg);
            const q = long ? S.sizeQuote(e * u, Math.min(b.quote, e * u), A.stopPct, cfg, rs) : S.sizeShortBase(e * u, px, A.stop, b.base, cfg, rs);
            return { A, q, ok: long ? q >= cfg.minTradeQuote : q * px >= cfg.minTradeQuote }; };
          const L = can(true), Sh = state.shortOn ? can(false) : { ok: false };
          if (up && L.ok) await enter(true, px, L.A.stop, L.A.target, L.q, 'always-in: trend UP');
          else if (!up && Sh.ok) await enter(false, px, Sh.A.stop, Sh.A.target, Sh.q, 'always-in: trend DOWN');
          else if (!up && !state.shortOn && L.ok && cfg.alwaysInLongOnDown) await enter(true, px, L.A.stop, L.A.target, L.q, 'always-in: long (shorts off)');
          else if (Date.now() - (last.noteAt || 0) > 60000) { last.noteAt = Date.now(); addLog('info', `always-in waiting: trend ${up ? 'UP' : 'DOWN'}, ${up ? 'long size too small' : state.shortOn ? 'short unavailable (needs XRP above reserve)' : 'shorts are OFF'}`); }
          }
        }
      }
    }
    save();
  } catch (err) { last.err = err.message; log('tick error:', err.message); if (!MOCK && ++errRun >= 4) rotateServer(); }
}
// ---------- simultaneous pairs: every active pair runs its own tick, one after another, by swapping the per-pair runtime in and out ----------
const ctxMap = {}; let viewPair = null;
let tradeOK = true;
const snapCtx = () => ({ candles, last, startEq, runStartEq, prevB, offC, offAt, xuC, xuAt, dayKey, balC, balAt, eqArr: eq.slice() });
function loadCtx(id) {
  pair = pairById(id); const c = ctxMap[id];
  if (c) { P = state.pairs[id] ||= { closed: [], cur: null, pos: null, cooldownUntil: 0, consec: 0, paper: { base: 0, quote: 1000 } }; P.ticks ||= []; ({ candles, last, startEq, runStartEq, prevB, offC, offAt, xuC, xuAt, dayKey, balC, balAt } = c); eq.length = 0; eq.push(...c.eqArr); }
  else { loadPair(); last = { px: null, sig: { trend: 'NONE', why: 'warming up' }, err: null }; runStartEq = null; prevB = null; offC = []; offAt = 0; xuC = null; xuAt = 0; dayKey = null; balC = null; balAt = 0; }
  if (P.use == null && pair.id === 'BTC/XRP') P.use = 50;
}
const activeIds = () => { const s = new Set([pair.id, ...(state.active || [pair.id])]); for (const id of Object.keys(state.pairs || {})) if (state.pairs[id] && (state.pairs[id].pos || state.pairs[id].pend) && pairById(id)) s.add(id); return [...s].filter(id => pairById(id)); };
async function tick() {
  if (busy) { if (Date.now() - busySince > 90000) { log('watchdog: tick was stuck for 90s, resetting'); busy = false; } else return; } busy = true; busySince = Date.now();
  const view0 = pair.id; viewPair = view0;
  try {
    for (const id of activeIds()) {
      if (pair.id !== id) { ctxMap[pair.id] = snapCtx(); loadCtx(id); }
      tradeOK = (state.active || [view0]).includes(id);
      busySince = Date.now();
      await tickBody();
    }
  } finally {
    try { ctxMap[pair.id] = snapCtx(); if (pair.id !== view0) loadCtx(view0); } catch (e) { log('ctx restore failed:', e.message); }
    tradeOK = true; viewPair = null; busy = false;
  }
}
async function locked(fn) { while (busy && Date.now() - busySince < 90000) await sleep(60); busy = true; busySince = Date.now(); try { return await fn(); } finally { busy = false; } }

// ---------- API ----------
const view = () => {
  const cs = candles.closed.slice(-200);
  const frac = candles.cur ? Math.min(1, (Date.now() - candles.cur.t) / candles.tf) : 0;
  return {
    active: state.active || [pair.id], multi: pairs.map(p => { const q = state.pairs[p.id] || {}, c = p.id === pair.id ? { last } : (ctxMap[p.id] || {}), l = c.last || {}; return { id: p.id, on: (state.active || []).includes(p.id), side: q.pos ? q.pos.side : null, px: l.px ?? null, err: l.err || null, trades: hist.trades.filter(t => t.pair === p.id).length, pnl: +hist.trades.filter(t => t.pair === p.id).reduce((a, t) => a + (t.pnl || 0), 0).toFixed(6), open: q.pos ? +(q.pos.side === 'SHORT' ? q.pos.cost - q.pos.base * (l.px || 0) : q.pos.base * (l.px || 0) - q.pos.cost).toFixed(6) : 0, quote: sym(p.quote.currency) }; }),
    ver: 3.1, plan: last.plan || null, pend: P.pend ? { long: P.pend.long, price: P.pend.price, base: P.pend.base, age: Math.round((Date.now() - P.pend.t0) / 1000) } : null, offers: offC.map(o => ({ ...o, bot: P.pend && o.seq === P.pend.seq ? 'entry' : P.pos && P.pos.tp && o.seq === P.pos.tp.seq ? 'take-profit' : null })), fx: last.fx || null, dayPct: last.tp ?? null, dexN: last.dexN || 0, ledger: last.ledger || null, server: last.server || null, src: last.src || null, ref: last.ref || null, refDev: (last.ref && last.px && pair.id.startsWith('XRP/')) ? (last.px / last.ref - 1) * 100 : null, dexErr: last.dexErr || null, ask: last.ask || null, bid: last.bid || null, tickAt: last.at || null, nTicks: P.ticks.length, live: !!wallet, address: wallet ? wallet.address : null, mock: MOCK, pair: pair.id, pairs: pairs.map(p => p.id),
    quoteSym: sym(pair.quote.currency), baseSym: sym(pair.base.currency),
    px: last.px, cs, cur: candles.cur, cinfo: `${cfg.timeframeMinutes}m candles · ${candles.closed.length} closed · ${Math.round(frac * 100)}%`,
    pos: P.pos, sig: last.sig, halted: state.halted || null, autoOn: state.autoOn, shortOn: state.shortOn, err: last.err,
    use: P.use ?? 100, goal: P.goal || 0, goalHit: !!P.goalHit, trades: hist.trades.filter(t => !t.pair || t.pair === pair.id).slice(-5000), base0: (hist.base[pair.id] || {}).eq ?? null, histSince: hist.since, histEq: hist.eq.filter(p => p[2] === pair.id).slice(-3000).map(p => [p[0], p[1]]), nTradesAll: state.trades.length, marks: (P.marks || []).slice(-120), eq, start: startEq, logs, cfg: { ...S.DEFAULTS, ...cfg }, consec: P.consec, bal: balC, smart: cfg.smart !== false, brain: brain.view(cfg, P.consec), orphans: Math.max(0, offC.length - (P.pend ? 1 : 0) - (P.pos && P.pos.tp ? 1 : 0)), eqAll: last.eqAll ?? null, wal: walC ? { ...walC, at: walAt } : null, wtx: walTxC, noTrust: last.noTrust || null, eqNow: last.eq ?? null, note: last.note || null,
  };
};
const body = req => new Promise((res, rej) => { let d = ''; req.on('data', c => { d += c; if (d.length > 20000) { rej(new Error('too large')); req.destroy(); } }); req.on('end', () => { try { res(d ? JSON.parse(d) : {}); } catch (e) { rej(e); } }); });
const num = (v, name) => { const n = Number(v); if (!isFinite(n) || n <= 0) throw new Error('bad ' + name); return n; };

const routes = {
  'GET /api/state': async () => view(),
  'GET /api/wallet': async () => { if (!wallet) throw new Error('No wallet connected'); if (MOCK) throw new Error('mock mode'); const [w, tx] = await Promise.all([walletData(), walletTx()]); return { ...w, tx }; },
  'POST /api/import': async (b) => {
    if (P.pos) throw new Error('Close the open position before switching wallets');
    const w = xrpl.Wallet.fromSeed(String(b.seed || '').trim()); // throws on invalid seed
    wallet = w; addLog('info', 'Wallet connected: ' + w.address); loadPair(); return { address: w.address };
  },
  'POST /api/disconnect': async () => { if (P.pos) throw new Error('Close the open position first'); wallet = null; addLog('info', 'Wallet disconnected (seed cleared from memory)'); loadPair(); return {}; },
  'POST /api/pair': async (b) => locked(async () => { const p = pairById(b.id); if (!p) throw new Error('unknown pair'); if (p.id === pair.id) return {}; ctxMap[pair.id] = snapCtx(); loadCtx(p.id); state.pairId = p.id; save(); return {}; }),
  'POST /api/active': async (b) => locked(async () => { const p = pairById(b.id); if (!p) throw new Error('unknown pair'); const a = new Set(state.active || [pair.id]); if (b.on) a.add(p.id); else { const q = state.pairs[p.id]; if (q && (q.pos || q.pend)) throw new Error('Close its open position / pending order first (it keeps being managed until then)'); a.delete(p.id); } if (!a.size) throw new Error('Keep at least one pair trading'); state.active = [...a]; save(); return {}; }),
  'POST /api/addpair': async (b) => {
    const symb = String(b.symbol || '').trim(), issuer = String(b.issuer || '').trim(), qt = b.quote === 'XRP' ? XRP : RLUSD;
    if (!symb || !xrpl.isValidClassicAddress(issuer)) throw new Error('need a currency code and a valid issuer address');
    const id = `${symb}/${sym(qt.currency)}`; if (pairById(id)) throw new Error('pair exists');
    const p = { id, base: { currency: hex(symb), issuer }, quote: qt }; pairs.push(p);
    fs.writeFileSync(F('pairs.json'), JSON.stringify(pairs.slice(1))); return { id };
  },
  'POST /api/lines': async (b) => locked(async () => {
    if (!P.pos) throw new Error('No open position');
    const sh = P.pos.side === 'SHORT';
    if (b.stop != null) { const s = num(b.stop, 'stop'); if (sh ? s <= last.px : s >= last.px) throw new Error(sh ? 'Short stop must be above the price' : 'Stop must be below the current price'); P.pos.stop = s; P.pos.userStop = true; }
    if (b.target !== undefined) { P.pos.target = b.target == null ? null : num(b.target, 'target'); if (P.pos.target && (sh ? P.pos.target >= last.px : P.pos.target <= last.px)) throw new Error(sh ? 'Short target must be below the price' : 'Target must be above the current price'); }
    if (P.pos.tp && b.target !== undefined) { await cancelOffer(P.pos.tp.seq); P.pos.tp = null; if (P.pos.target) await placeTp(P.pos); }
    save(); return {};
  }),
  'POST /api/buy': async (b) => locked(async () => {
    if (P.pos) throw new Error('Already in a position');
    const px = await price(), stop = num(b.stop, 'stop'); if (stop >= px) throw new Error('Stop must be below the current price');
    const target = b.target ? num(b.target, 'target') : null; if (target && target <= px) throw new Error('Target must be above price');
    const bal = await balances(), e = equityOf(bal, px), sp = ((px - stop) / px) * 100;
    const spend = S.sizeQuote(e * useFrac(), Math.min(bal.quote, e * useFrac()), sp, cfg);
    if (!(spend >= cfg.minTradeQuote)) throw new Error(`Nothing to trade with: spendable ${bal.quote.toFixed(6)} ${sym(pair.quote.currency)} (risk-sized ${spend.toFixed(6)}). Fund the wallet or add a trust line.`);
    if (!(await openPos(px, stop, target, spend, 'manual'))) throw new Error('Order not filled');
    P.pos.userStop = true; save(); return {};
  }),
  'POST /api/short': async (b) => locked(async () => {
    if (P.pos) throw new Error('Already in a position');
    const px = await price(), stop = num(b.stop, 'stop'); if (stop <= px) throw new Error('Short stop must be above the price');
    const target = b.target ? num(b.target, 'target') : null; if (target && target >= px) throw new Error('Short target must be below the price');
    const bal = await balances(), e = equityOf(bal, px), qty = S.sizeShortBase(e * useFrac(), px, stop, bal.base, cfg);
    if (!(qty * px >= cfg.minTradeQuote)) throw new Error(`No ${sym(pair.base.currency)} to short: spendable ${bal.base.toFixed(6)} (XRP below the account reserve + ${cfg.xrpReserveBuffer} fee buffer can't be sold). Send some ${sym(pair.base.currency)} to the wallet.`);
    if (!(await openShort(px, stop, target, qty, 'manual'))) throw new Error('Order not filled');
    P.pos.userStop = true; save(); return {};
  }),
  'POST /api/shorton': async (b) => { state.shortOn = !!b.on; return {}; },
  'POST /api/sell': async () => locked(async () => { if (P.pend) { await cancelOffer(P.pend.seq); P.pend = null; } if (!P.pos) throw new Error('No open position'); await closeAll('manual'); save(); return {}; }),
  'POST /api/auto': async (b) => { state.autoOn = !!b.on; return {}; },
  'POST /api/kill': async () => { state.halted = 'kill switch'; addLog('loss', 'Kill switch pressed'); return {}; },
  'POST /api/resume': async () => { state.halted = null; P.consec = 0; P.dayPnl = 0; startEq = null; addLog('info', 'Resumed'); return {}; },
  'POST /api/config': async (b) => {
    const D = S.DEFAULTS; if (!D) throw new Error('strategy defaults unavailable');
    for (const k of Object.keys(b)) {
      if (!(k in D) && !(k in cfg)) continue;
      const ref = k in cfg ? cfg[k] : D[k], v = b[k];
      if (typeof ref === 'number' && isFinite(+v) && +v >= 0) cfg[k] = +v;
      else if (typeof ref === 'boolean') cfg[k] = !!v;
      else if (typeof ref === 'string' && typeof v === 'string' && v.length < 24) cfg[k] = v;
      else if (Array.isArray(ref) && Array.isArray(v) && v.length <= 6 && v.every(x => isFinite(+x.r) && isFinite(+x.pct))) cfg[k] = v.map(x => ({ r: +x.r, pct: +x.pct }));
    }
    return {};
  },
  'POST /api/tf': async (b) => locked(async () => {
    const m = Math.round(+b.minutes); if (!(m >= 1 && m <= 1440)) throw new Error('bad timeframe');
    cfg.timeframeMinutes = m; candles = S.buildCandles(P.ticks, m);
    if (P.pos) P.pos.entryCandleT = candles.cur ? candles.cur.t : P.pos.entryCandleT;
    P.marks = []; save(); addLog('info', `timeframe ${m}m · rebuilt ${candles.closed.length} candles from ${P.ticks.length} live ticks`); return {};
  }),
  'POST /api/flatten': async () => locked(async () => { if (P.pend) { await cancelOffer(P.pend.seq); P.pend = null; } if (!P.pos) { pauseAuto(); return {}; } await closeAll('flatten'); save(); return {}; }),
  'POST /api/take': async (b) => locked(async () => { if (!P.pos) throw new Error('No open position'); const px = await price(); const f = Math.min(1, Math.max(0.05, +b.frac || 0.5)); if (!(await closePos(px, 'take profit', cfg.entrySlippagePct, f))) throw new Error('Order not filled'); save(); return {}; }),
  'POST /api/hedge': async () => { throw new Error('Hedge (long+short) is simulator-only for now'); },
  'POST /api/smart': async (b) => { cfg.smart = !!b.on; addLog('info', 'Smart brain ' + (cfg.smart ? 'ON' : 'OFF')); return {}; },
  'POST /api/deltrade': async (b) => { const n = purgeTrades(t => t.t === +b.t && t.side === b.side && Math.abs(t.entry - +b.entry) < 1e-9); saveHist(true); save(); return { removed: n }; },
  'POST /api/purge': async () => { const n = purgeTrades(t => Math.abs(t.pnl) > tradeLimit(t.pair) || (t.reason === 'stop' && t.r > 0 && t.pnl > 0 && Math.abs(t.pnl) > 5 * Math.max(0.5, tradeLimit(t.pair) / 3 * 0.05))); saveHist(true); save(); return { removed: n }; },
  'POST /api/smartfeat': async (b) => { const id = String(b.id || ''); if (!require('./brain').FEATURES.some(f => f.id === id)) throw new Error('unknown feature'); const off = new Set(cfg.smartOff || []); if (b.on) off.delete(id); else off.add(id); cfg.smartOff = [...off]; return {}; },
  'POST /api/limit': async (b) => locked(async () => {
    if (!wallet) throw new Error('Connect a wallet to place real orders'); if (MOCK) throw new Error('mock mode');
    const side = b.side === 'sell' ? 'SELL' : 'BUY', pr = num(b.price, 'price'), amtB = num(b.amount, 'amount'), px = last.px;
    if (px && Math.abs(pr - px) / px > 0.5) throw new Error('Limit price is more than 50% from the market, check it');
    if (amtB * pr < cfg.minTradeQuote) throw new Error('Order too small');
    const bal = await balances();
    if (side === 'BUY' && amtB * pr > bal.quote + 1e-9) throw new Error(`Need ${(amtB * pr).toFixed(4)} ${sym(pair.quote.currency)}, spendable ${bal.quote.toFixed(4)}`);
    if (side === 'SELL' && amtB > bal.base + 1e-9) throw new Error(`Need ${amtB} ${sym(pair.base.currency)}, spendable ${bal.base.toFixed(4)}`);
    const gets = side === 'BUY' ? amount(pair.quote, amtB * pr) : amount(pair.base, amtB), pays = side === 'BUY' ? amount(pair.base, amtB) : amount(pair.quote, amtB * pr);
    const res = await sub({ TransactionType: 'OfferCreate', Account: wallet.address, TakerGets: gets, TakerPays: pays }, { wallet, autofill: true });
    const code = res.result.meta.TransactionResult; offAt = 0; balAt = 0;
    if (code !== 'tesSUCCESS') throw new Error('Order rejected: ' + code);
    addLog('info', `LIMIT ${side} ${amtB} ${sym(pair.base.currency)} @ ${pr} placed (rests on the book until filled or cancelled)`); return {};
  }),
  'POST /api/cancel': async (b) => {
    if (!wallet) throw new Error('No wallet'); const seq = Math.round(+b.seq); if (!(seq > 0)) throw new Error('bad order sequence');
    const res = await sub({ TransactionType: 'OfferCancel', Account: wallet.address, OfferSequence: seq }, { wallet, autofill: true });
    const code = res.result.meta.TransactionResult; if (code !== 'tesSUCCESS' && code !== 'tecNO_ENTRY') throw new Error('Cancel failed: ' + code);
    if (P.pend && P.pend.seq === seq) P.pend = null; if (P.pos && P.pos.tp && P.pos.tp.seq === seq) P.pos.tp = null;
    offAt = 0; balAt = 0; pauseAuto(); addLog('info', 'Order #' + seq + ' cancelled' + (code === 'tecNO_ENTRY' ? ' (it was already gone)' : '')); refreshOffers(true).catch(() => {}); return {};
  },
  'POST /api/send': async (b) => locked(async () => {
    if (!wallet) throw new Error('No wallet connected'); if (MOCK) throw new Error('mock mode');
    if (b.confirm !== true) throw new Error('Not confirmed');
    if (Object.values(state.pairs || {}).some(q => q && (q.pos || q.pend))) throw new Error('Close open positions / cancel pending entries (all pairs) first: sending funds would break their accounting');
    const to = String(b.to || '').trim(); if (!xrpl.isValidClassicAddress(to)) throw new Error('Invalid destination address'); if (to === wallet.address) throw new Error('Destination is this wallet');
    const n = num(b.amount, 'amount'), cur = String(b.currency || 'XRP'), w = await walletData(); let Amount;
    if (cur === 'XRP') { if (n > w.spendable + 1e-9) throw new Error(`Only ${w.spendable.toFixed(4)} XRP is spendable (reserve + buffer held back)`); Amount = xrpl.xrpToDrops(n.toFixed(6)); }
    else { const l = w.lines.find(x => x.raw === cur && x.issuer === b.issuer); if (!l) throw new Error('No such trust line on this wallet'); if (n > l.balance + 1e-9) throw new Error(`Only ${l.balance} ${sym(cur)} available`); Amount = { currency: cur, issuer: l.issuer, value: String(n) }; }
    const tx = { TransactionType: 'Payment', Account: wallet.address, Destination: to, Amount };
    if (b.tag !== undefined && b.tag !== null && String(b.tag).trim() !== '') { const t = Number(b.tag); if (!Number.isInteger(t) || t < 0 || t > 4294967295) throw new Error('Invalid destination tag'); tx.DestinationTag = t; }
    const res = await sub(tx, { wallet, autofill: true }), code = res.result.meta.TransactionResult;
    balAt = 0; walTxAt = 0; if (code !== 'tesSUCCESS') throw new Error('Payment failed: ' + code);
    addLog('info', `SENT ${n} ${cur === 'XRP' ? 'XRP' : sym(cur)} to ${to}${tx.DestinationTag !== undefined ? ' tag ' + tx.DestinationTag : ''} (${res.result.hash})`); return { hash: res.result.hash };
  }),
  'POST /api/trust': async (b) => locked(async () => {
    if (!wallet) throw new Error('No wallet connected'); if (MOCK) throw new Error('mock mode');
    const symb = String(b.symbol || '').trim(), issuer = String(b.issuer || '').trim();
    if (!symb || !xrpl.isValidClassicAddress(issuer)) throw new Error('need a currency code and a valid issuer address');
    const res = await sub({ TransactionType: 'TrustSet', Account: wallet.address, LimitAmount: { currency: hex(symb), issuer, value: String(b.limit || '1000000000') } }, { wallet, autofill: true }), code = res.result.meta.TransactionResult;
    balAt = 0; if (code !== 'tesSUCCESS') throw new Error('Trust line failed: ' + code);
    addLog('info', `Trust line set for ${symb} (${issuer}): you can now receive it (holds 0.2 XRP reserve)`); return {};
  }),
  'POST /api/cancelall': async () => {
    if (!wallet) throw new Error('No wallet'); await refreshOffers(true); let n = 0, fails = 0;
    for (const o of [...offC]) { try { const res = await sub({ TransactionType: 'OfferCancel', Account: wallet.address, OfferSequence: o.seq }, { wallet, autofill: true }); const c = res.result.meta.TransactionResult; if (c === 'tesSUCCESS' || c === 'tecNO_ENTRY') n++; else fails++; } catch (e) { fails++; addLog('info', 'cancel #' + o.seq + ' failed: ' + e.message); } }
    P.pend = null; if (P.pos) P.pos.tp = null; offAt = 0; balAt = 0; pauseAuto(); addLog('info', `Cancelled ${n} open order(s) on ${pair.id}${fails ? ', ' + fails + ' failed' : ''}`); await refreshOffers(true).catch(() => {}); if (fails && !n) throw new Error('Could not cancel: see the log'); return { n, fails };
  },
  'POST /api/alloc': async (b) => { if (b.use != null) P.use = Math.min(100, Math.max(5, +b.use || 100)); if (b.goal != null) P.goal = Math.min(50, Math.max(0, +b.goal || 0)); save(); return { use: P.use ?? 100, goal: P.goal || 0 }; },
};

const server = http.createServer(async (req, res) => {
  const send = (code, obj, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(type === 'application/json' ? JSON.stringify(obj) : obj); };
  try {
    const host = req.headers.host || '';
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(403, { error: 'bad host' });
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) return send(200, fs.readFileSync(F('ui.html'), 'utf8'), 'text/html; charset=utf-8');
    const h = routes[`${req.method} ${url}`];
    if (!h) return send(404, { error: 'not found' });
    if (req.method === 'POST') {
      const o = req.headers.origin; // block other websites from driving the bot
      if (req.headers['x-tb'] !== '1' || (o && o !== `http://${host}`)) return send(403, { error: 'forbidden' });
    }
    send(200, await h(req.method === 'POST' ? await body(req) : {}));
  } catch (e) { send(400, { error: e.message }); }
});

const SERVERS = () => [...new Set([process.env.TB_SERVER || cfg.server, ...(process.env.TB_SERVER ? [] : ['wss://xrplcluster.com', 'wss://s1.ripple.com', 'wss://s2.ripple.com'])])];
let srvIdx = 0, errRun = 0, rotating = false;
async function connectClient(i) {
  const list = SERVERS(); srvIdx = i % list.length; const url = list[srvIdx];
  const old = client; client = null; if (old) { try { old.removeAllListeners(); await old.disconnect(); } catch {} }
  const c = new xrpl.Client(url, { timeout: 15000 });
  c.on('disconnected', () => log('disconnected from', url));
  c.on('ledgerClosed', l => { last.ledger = l.ledger_index; last.ledgerAt = Date.now(); tick(); }); // re-price on every validated ledger (~3-4s)
  await c.connect(); client = c; last.server = url;
  try { await c.request({ command: 'subscribe', streams: ['ledger'] }); } catch (e) { log('ledger subscribe failed:', e.message); }
  log('connected to', url);
}
async function rotateServer() {
  if (rotating) return; rotating = true;
  try { await connectClient(srvIdx + 1); errRun = 0; } catch (e) { log('server switch failed:', e.message); } finally { rotating = false; }
}
// Independent reference price (Bitstamp XRP/USD, RLUSD ~ $1): only flags a bad feed, never traded on.
async function refPrice() {
  try { const r = await fetch('https://www.bitstamp.net/api/v2/ticker/xrpusd/'); const j = await r.json(); last.ref = Number(j.last); last.refAt = Date.now(); } catch (e) { last.refErr = e.message; }
}
async function main() {
  if (process.env.BOT_SEED) { wallet = xrpl.Wallet.fromSeed(process.env.BOT_SEED.trim()); delete process.env.BOT_SEED; }
  loadPair();
  if (!MOCK) await connectClient(0);
  server.on('error', e => { if (e.code === 'EADDRINUSE') { console.error(`\nPort ${PORT} is already in use: an OLD TRENDBOT is still running and is what your browser is showing.\nStop it first: run STOP-TRENDBOT.command, or in Terminal: pkill -f "node bot.js", then start again.\n`); process.exit(1); } throw e; });
  server.listen(PORT, '127.0.0.1', () => log(`TRENDBOT UI: http://127.0.0.1:${PORT} | ${wallet ? 'LIVE ' + wallet.address : 'PAPER (import a wallet on the Wallet page for live)'}${MOCK ? ' | MOCK PRICES' : ''}`));
  setInterval(tick, cfg.pollSeconds * 1000); tick(); refPrice(); setInterval(refPrice, 10000);
}
main().catch(e => { console.error(e); process.exit(1); });
