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
try { pairs = pairs.concat(JSON.parse(fs.readFileSync(F('pairs.json'), 'utf8'))); } catch {}
const pairById = id => pairs.find(p => p.id === id);

// ---------- state ----------
let wallet = null, client = null, busy = false;
let state = (() => { try { return JSON.parse(fs.readFileSync(F('state.json'), 'utf8')); } catch { return {}; } })();
state.pairId ||= 'XRP/RLUSD'; state.autoOn ??= true; state.shortOn ??= false; state.pairs ||= {}; state.trades ||= [];
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
  P.closed = candles.closed; P.cur = candles.cur; state.pairId = pair.id;
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
async function bookBest(p) {
  const bx = isXRP(p.base) ? 1e6 : 1, qx = isXRP(p.quote) ? 1e6 : 1;
  const [asks, bids] = await Promise.all([
    client.request({ command: 'book_offers', taker_gets: asset(p.base), taker_pays: asset(p.quote), limit: 1 }),
    client.request({ command: 'book_offers', taker_gets: asset(p.quote), taker_pays: asset(p.base), limit: 1 }),
  ]);
  const a = asks.result.offers[0], b = bids.result.offers[0];
  return { ask: a ? (Number(a.quality) * bx) / qx : null, bid: b ? 1 / ((Number(b.quality) * qx) / bx) : null };
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
  last.ask = ask; last.bid = bid;
  return v;
}
async function walletData() {
  const [info, lines, srv, offers] = await Promise.all([
    client.request({ command: 'account_info', account: wallet.address, ledger_index: 'validated' }),
    client.request({ command: 'account_lines', account: wallet.address, ledger_index: 'validated', limit: 400 }),
    client.request({ command: 'server_info' }),
    client.request({ command: 'account_offers', account: wallet.address, limit: 50 }),
  ]);
  const vl = srv.result.info.validated_ledger, owner = info.result.account_data.OwnerCount;
  const reserve = vl.reserve_base_xrp + vl.reserve_inc_xrp * owner;
  const bal = Number(info.result.account_data.Balance) / 1e6;
  return {
    address: wallet.address, xrp: bal, reserve, spendable: Math.max(0, bal - reserve - cfg.xrpReserveBuffer), owner,
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
  const w = await walletData();
  const get = a => {
    if (isXRP(a)) return w.spendable;
    const l = w.lines.find(x => x.raw === a.currency && x.issuer === a.issuer);
    if (!l) throw new Error(`No trust line for ${sym(a.currency)} on this wallet. Add it first.`);
    return l.balance;
  };
  return { base: get(pair.base), quote: get(pair.quote) };
}

// ---------- execution ----------
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
  const res = await client.submitAndWait({ TransactionType: 'OfferCreate', Account: wallet.address, TakerGets: gets, TakerPays: pays, Flags: IOC }, { wallet, autofill: true });
  const code = res.result.meta.TransactionResult;
  await sleep(1500);
  const after = await balances();
  const fee = Number(res.result.Fee || 0) / 1e6;
  const dB = after.base - before.base + (isXRP(pair.base) ? fee : 0);
  const dQ = after.quote - before.quote + (isXRP(pair.quote) ? fee : 0);
  if (code !== 'tesSUCCESS' || Math.abs(dQ) < 1e-9) return { filled: false, code };
  return { filled: true, code, base: Math.abs(dB), quote: Math.abs(dQ), price: Math.abs(dQ) / Math.abs(dB) };
}

async function openPos(px, stop, target, spendQuote, why) {
  const r = await swap('BUY', spendQuote, px, cfg.entrySlippagePct);
  if (!r.filled) { addLog('info', `BUY not filled (${r.code})`); return false; }
  P.pos = { side: 'LONG', base: r.base, cost: r.quote, entry: r.price, stop, target, userStop: false, entryCandleT: candles.cur.t, risk: Math.abs(r.price - stop) * r.base, t0: Date.now(), stop0: stop, base0: r.base, done: [] };
  P.tradesToday = (P.tradesToday || 0) + 1;
  (P.marks ||= []).push({ t: candles.cur.t, price: r.price, kind: 'buy' }); if (P.marks.length > 200) P.marks.shift();
  logTrade([new Date().toISOString(), pair.id, 'BUY', wallet ? 'live' : 'paper', why, r.base.toFixed(6), r.quote.toFixed(6), r.price.toPrecision(8), '']);
  addLog('buy', `BUY ${r.base.toFixed(2)} ${sym(pair.base.currency)} @ ${r.price.toPrecision(6)} · stop ${stop.toPrecision(6)}`);
  return true;
}
async function openShort(px, stop, target, qtyBase, why) {
  const r = await swap('SELL', qtyBase, px, cfg.entrySlippagePct);
  if (!r.filled) { addLog('info', `SHORT not filled (${r.code})`); return false; }
  P.pos = { side: 'SHORT', base: r.base, cost: r.quote, entry: r.price, stop, target, userStop: false, entryCandleT: candles.cur.t, risk: Math.abs(stop - r.price) * r.base, t0: Date.now(), stop0: stop, base0: r.base, done: [] };
  P.tradesToday = (P.tradesToday || 0) + 1;
  (P.marks ||= []).push({ t: candles.cur.t, price: r.price, kind: 'short' }); if (P.marks.length > 200) P.marks.shift();
  logTrade([new Date().toISOString(), pair.id, 'SHORT', wallet ? 'live' : 'paper', why, r.base.toFixed(6), r.quote.toFixed(6), r.price.toPrecision(8), '']);
  addLog('sell', `SHORT (sold ${r.base.toFixed(2)} ${sym(pair.base.currency)}) @ ${r.price.toPrecision(6)} · stop ${stop.toPrecision(6)}`);
  return true;
}
async function closePos(px, reason, slip, frac = 1) {
  const pos = P.pos, short = pos.side === 'SHORT';
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
  const portion = Math.min(1, r.base / pos.base);
  const pnl = short ? pos.cost * portion - r.quote : r.quote - pos.cost * portion;
  pos.cost -= pos.cost * portion; pos.base -= r.base;
  state.trades.push({ t: Date.now(), pair: pair.id, side: short ? 'SHORT' : 'LONG', entry: pos.entry, exit: r.price, pnl: +pnl.toFixed(6), r: pos.risk ? +(pnl / (pos.risk * portion)).toFixed(3) : null, reason, bars: pos.t0 ? Math.max(0, Math.round((Date.now() - pos.t0) / candles.tf)) : 0 }); if (state.trades.length > 500) state.trades.shift();
  (P.marks ||= []).push({ t: candles.cur.t, price: r.price, kind: short ? 'cover' : 'sell' });
  logTrade([new Date().toISOString(), pair.id, short ? 'COVER' : 'SELL', wallet ? 'live' : 'paper', reason, r.base.toFixed(6), r.quote.toFixed(6), r.price.toPrecision(8), pnl.toFixed(6)]);
  addLog(pnl < 0 ? 'loss' : 'sell', `${short ? 'COVER' : 'SELL'} ${r.base.toFixed(2)} @ ${r.price.toPrecision(6)} · ${reason} · ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} ${sym(pair.quote.currency)}`);
  if (pos.base < 1e-6 || pos.base * px < Math.max(1e-6, cfg.minTradeQuote * 0.1) || (short && portion > 0.98)) { P.consec = pnl < 0 ? P.consec + 1 : 0; P.cooldownUntil = (candles.cur?.t || Date.now()) + cfg.cooldownCandles * cfg.timeframeMinutes * 60_000; P.pos = null; }
  return true;
}

// ---------- strategy context / allocation ----------
const mkCtx = () => S.ctxFrom(candles.closed, S.aggregate(candles.closed, candles.cur, cfg.htfMult || 4), { tradesToday: P.tradesToday || 0 });
const useFrac = () => Math.min(1, Math.max(0.05, (P.use ?? 100) / 100));
let balC = null, balAt = 0;
// ---------- main tick ----------
let last = { px: null, sig: { trend: 'NONE', why: 'warming up' }, err: null };
const equityOf = (b, px) => b.quote + b.base * px;
async function tick() {
  if (busy) return; busy = true;
  try {
    const px = await price(); last.px = px; last.err = null; last.at = Date.now();
    const now = Date.now();
    try { await dexWicks(pair, px); } catch (e) { last.dexErr = e.message; }
    P.ticks.push([now, px]);
    const closedNow = candles.push(now, px);
    const b = (Date.now() - balAt < 8000 && balC) ? balC : await balances(); balC = b; balAt = Date.now();
    const e = equityOf(b, px);
    if (startEq == null) startEq = e;
    const dk = new Date().toISOString().slice(0, 10);
    if (dk !== dayKey) { dayKey = dk; startEq = e; P.tradesToday = 0; P.goalHit = false; if (state.halted && /daily goal/.test(state.halted)) state.halted = null; }
    eq.push(e); if (eq.length > 600) eq.shift();
    last.eq = e; last.note = e * useFrac() < cfg.minTradeQuote * 2 ? `Wallet too small to trade: equity ${e.toFixed(3)} ${sym(pair.quote.currency)} (XRP counted only above reserve + ${cfg.xrpReserveBuffer} buffer). Needs roughly ${(cfg.minTradeQuote * 2).toFixed(0)}+ to place orders.` : null;
    const ctx = mkCtx();
    if (P.goal > 0 && !P.goalHit && startEq && ((e - startEq) / startEq) * 100 >= P.goal) { P.goalHit = true; state.halted = `daily goal +${P.goal}% reached`; addLog('buy', 'DAILY GOAL reached: flattening, resumes tomorrow'); }
    const halt = fs.existsSync(F('STOP')) ? 'STOP file present' : state.halted;
    if (P.pos) {
      const m = (P.pos.side === 'SHORT' ? S.manageShort : S.manage)(P.pos, px, candles.closed, cfg, ctx);
      P.pos.stop = m.stop;
      if (m.partial && !m.exit && !halt) { const q = P.pos.base0 * m.partial; if (await closePos(px, `ladder ${m.level + 1}`, cfg.entrySlippagePct, Math.min(1, q / P.pos.base))) { if (P.pos) P.pos.done.push(m.level); } }
      else if (m.exit || halt) await closePos(px, halt ? 'halt: ' + halt : m.reason, m.reason === 'take-profit' ? cfg.entrySlippagePct : cfg.stopSlippagePct);
    } else {
      const sig = S.entrySignal(candles.closed, px, cfg, ctx); last.sig = sig;
      if (closedNow) addLog('info', `candle closed H ${closedNow.high.toPrecision(6)} L ${closedNow.low.toPrecision(6)} | ${sig.why}`);
      if (!halt && state.autoOn) {
        const dd = ((startEq - e) / startEq) * 100;
        if (dd >= cfg.dailyLossHaltPct) { state.halted = `daily loss ${dd.toFixed(2)}% hit limit`; addLog('loss', 'HALT ' + state.halted); }
        else if (P.consec >= cfg.maxConsecutiveLosses) { state.halted = `${P.consec} losses in a row`; addLog('loss', 'HALT ' + state.halted); }
        else if (now >= P.cooldownUntil && sig.enter) {
          const u = useFrac(), spend = S.sizeQuote(e * u, Math.min(b.quote, e * u), sig.stopPct, cfg, S.riskScale(P.consec, cfg));
          if (spend >= cfg.minTradeQuote) await openPos(px, sig.stop, sig.target, spend, sig.why);
          else { last.note = `SIGNAL but size ${spend.toFixed(3)} < min ${cfg.minTradeQuote} ${sym(pair.quote.currency)}: wallet too small (equity ${e.toFixed(3)}, spendable ${b.quote.toFixed(3)} ${sym(pair.quote.currency)})`; if (Date.now() - (last.noteAt || 0) > 60000) { last.noteAt = Date.now(); addLog('info', last.note); } }
        } else if (now >= P.cooldownUntil && state.shortOn) {
          const ss = S.shortSignal(candles.closed, px, cfg, ctx);
          if (ss.enter) {
            const u = useFrac(), qty = S.sizeShortBase(e * u, px, ss.stop, b.base, cfg, S.riskScale(P.consec, cfg));
            if (qty * px >= cfg.minTradeQuote) await openShort(px, ss.stop, ss.target, qty, ss.why);
          } else if (!sig.enter && sig.trend !== 'UP') last.sig = { ...sig, why: sig.why + ' · short: ' + ss.why };
        }
      }
    }
    save();
  } catch (err) { last.err = err.message; log('tick error:', err.message); }
  finally { busy = false; }
}
async function locked(fn) { while (busy) await sleep(60); busy = true; try { return await fn(); } finally { busy = false; } }

// ---------- API ----------
const view = () => {
  const cs = candles.closed.slice(-200);
  const frac = candles.cur ? Math.min(1, (Date.now() - candles.cur.t) / candles.tf) : 0;
  return {
    ver: 2.1, dexN: last.dexN || 0, dexErr: last.dexErr || null, ask: last.ask || null, bid: last.bid || null, tickAt: last.at || null, nTicks: P.ticks.length, live: !!wallet, address: wallet ? wallet.address : null, mock: MOCK, pair: pair.id, pairs: pairs.map(p => p.id),
    quoteSym: sym(pair.quote.currency), baseSym: sym(pair.base.currency),
    px: last.px, cs, cur: candles.cur, cinfo: `${cfg.timeframeMinutes}m candles · ${candles.closed.length} closed · ${Math.round(frac * 100)}%`,
    pos: P.pos, sig: last.sig, halted: state.halted || null, autoOn: state.autoOn, shortOn: state.shortOn, err: last.err,
    use: P.use ?? 100, goal: P.goal || 0, goalHit: !!P.goalHit, trades: state.trades.filter(t => !t.pair || t.pair === pair.id).slice(-300), marks: (P.marks || []).slice(-120), eq, start: startEq, logs, cfg: { ...S.DEFAULTS, ...cfg }, consec: P.consec, bal: balC, eqNow: last.eq ?? null, note: last.note || null,
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
  'POST /api/pair': async (b) => { if (P.pos) throw new Error('Close the open position before switching pairs'); const p = pairById(b.id); if (!p) throw new Error('unknown pair'); save(); pair = p; loadPair(); last = { px: null, sig: { trend: 'NONE', why: 'warming up' }, err: null }; return {}; },
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
    save(); return {};
  }),
  'POST /api/buy': async (b) => locked(async () => {
    if (P.pos) throw new Error('Already in a position');
    const px = await price(), stop = num(b.stop, 'stop'); if (stop >= px) throw new Error('Stop must be below the current price');
    const target = b.target ? num(b.target, 'target') : null; if (target && target <= px) throw new Error('Target must be above price');
    const bal = await balances(), e = equityOf(bal, px), sp = ((px - stop) / px) * 100;
    const spend = S.sizeQuote(e * useFrac(), Math.min(bal.quote, e * useFrac()), sp, cfg);
    if (spend < cfg.minTradeQuote) throw new Error('Size too small for the risk settings / balance');
    if (!(await openPos(px, stop, target, spend, 'manual'))) throw new Error('Order not filled');
    P.pos.userStop = true; save(); return {};
  }),
  'POST /api/short': async (b) => locked(async () => {
    if (P.pos) throw new Error('Already in a position');
    const px = await price(), stop = num(b.stop, 'stop'); if (stop <= px) throw new Error('Short stop must be above the price');
    const target = b.target ? num(b.target, 'target') : null; if (target && target >= px) throw new Error('Short target must be below the price');
    const bal = await balances(), e = equityOf(bal, px), qty = S.sizeShortBase(e * useFrac(), px, stop, bal.base, cfg);
    if (qty * px < cfg.minTradeQuote) throw new Error('Not enough base inventory to short at these risk settings');
    if (!(await openShort(px, stop, target, qty, 'manual'))) throw new Error('Order not filled');
    P.pos.userStop = true; save(); return {};
  }),
  'POST /api/shorton': async (b) => { state.shortOn = !!b.on; return {}; },
  'POST /api/sell': async () => locked(async () => { if (!P.pos) throw new Error('No open position'); const px = await price(); if (!(await closePos(px, 'manual', cfg.stopSlippagePct))) throw new Error('Order not filled'); save(); return {}; }),
  'POST /api/auto': async (b) => { state.autoOn = !!b.on; return {}; },
  'POST /api/kill': async () => { state.halted = 'kill switch'; addLog('loss', 'Kill switch pressed'); return {}; },
  'POST /api/resume': async () => { state.halted = null; P.consec = 0; startEq = null; addLog('info', 'Resumed'); return {}; },
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
  'POST /api/flatten': async () => locked(async () => { if (!P.pos) return {}; const px = await price(); if (!(await closePos(px, 'flatten', cfg.stopSlippagePct))) throw new Error('Order not filled'); save(); return {}; }),
  'POST /api/take': async (b) => locked(async () => { if (!P.pos) throw new Error('No open position'); const px = await price(); const f = Math.min(1, Math.max(0.05, +b.frac || 0.5)); if (!(await closePos(px, 'take profit', cfg.entrySlippagePct, f))) throw new Error('Order not filled'); save(); return {}; }),
  'POST /api/hedge': async () => { throw new Error('Hedge (long+short) is simulator-only for now'); },
  'POST /api/smart': async () => { throw new Error('Smart Auto is simulator-only for now'); },
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

async function main() {
  if (process.env.BOT_SEED) { wallet = xrpl.Wallet.fromSeed(process.env.BOT_SEED.trim()); delete process.env.BOT_SEED; }
  loadPair();
  if (!MOCK) { client = new xrpl.Client(cfg.server); client.on('disconnected', () => log('disconnected, reconnecting')); await client.connect(); }
  server.listen(PORT, '127.0.0.1', () => log(`TRENDBOT UI: http://127.0.0.1:${PORT} | ${wallet ? 'LIVE ' + wallet.address : 'PAPER (import a wallet on the Wallet page for live)'}${MOCK ? ' | MOCK PRICES' : ''}`));
  setInterval(tick, cfg.pollSeconds * 1000); tick();
}
main().catch(e => { console.error(e); process.exit(1); });
