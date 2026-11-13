'use strict';
// SMART BRAIN: regime engine + 25 named safeguards / learning rules for the live bot.
const STRAT = require('./strategy');
const trend = STRAT.trend;
function buildEngine(cfg) {
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const ema=(a,n)=>{const k=2/(n+1);let e=a[0];return a.map((v,i)=>{if(i)e=v*k+e*(1-k);return e})};
function atrArr(b,n=14){const tr=b.map((x,i)=>i?Math.max(x.high-x.low,Math.abs(x.high-b[i-1].close),Math.abs(x.low-b[i-1].close)):x.high-x.low);const o=[];let a=null;
  for(let i=0;i<tr.length;i++){if(i<n-1){o.push(null);continue}if(a==null){a=0;for(let j=0;j<n;j++)a+=tr[j];a/=n}else a=(a*(n-1)+tr[i])/n;o.push(a)}return o}
function rsiArr(c,n=14){const o=[];let ag=0,al=0;for(let i=0;i<c.length;i++){if(i===0){o.push(null);continue}const d=c[i]-c[i-1],g=Math.max(d,0),l=Math.max(-d,0);
  if(i<=n){ag+=g/n;al+=l/n;o.push(i<n?null:100-100/(1+ag/(al||1e-12)))}else{ag=(ag*(n-1)+g)/n;al=(al*(n-1)+l)/n;o.push(100-100/(1+ag/(al||1e-12)))}}return o}
function regression(c,n){const a=c.slice(-n),m=a.length;if(m<5)return null;let sx=0,sy=0,sxy=0,sxx=0;a.forEach((y,i)=>{sx+=i;sy+=y;sxy+=i*y;sxx+=i*i});
  const sl=(m*sxy-sx*sy)/(m*sxx-sx*sx),ic=(sy-sl*sx)/m;let r=0;a.forEach((y,i)=>r+=(y-(ic+sl*i))**2);return{sl,ic,sd:Math.sqrt(r/m),n:m}}
function pivots(b,k=3){const hi=[],lo=[];for(let i=k;i<b.length-k;i++){let H=true,L=true;for(let j=1;j<=k;j++){if(b[i].high<=b[i-j].high||b[i].high<=b[i+j].high)H=false;if(b[i].low>=b[i-j].low||b[i].low>=b[i+j].low)L=false}if(H)hi.push(b[i].high);if(L)lo.push(b[i].low)}return{hi,lo}}
function levels(b,atr){const p=pivots(b),all=p.hi.concat(p.lo).sort((x,y)=>x-y),out=[];all.forEach(v=>{const g=out[out.length-1];if(g&&Math.abs(v-g.p)<atr*.6){g.p=(g.p*g.n+v)/(g.n+1);g.n++}else out.push({p:v,n:1})});return out}
function pctile(a,q){const s=a.filter(v=>v!=null).slice().sort((x,y)=>x-y);return s.length?s[Math.floor((s.length-1)*q)]:null}
function engine(bars,px){
  const n=bars.length;if(n<24)return null;
  const cl=bars.map(b=>b.close),A=atrArr(bars),atr=A[n-1];if(!atr)return null;
  const rets=[];for(let i=Math.max(1,n-31);i<n;i++)rets.push(Math.log(cl[i]/cl[i-1]));const mu=rets.reduce((a,b)=>a+b,0)/rets.length,sig=Math.sqrt(rets.reduce((a,b)=>a+(b-mu)**2,0)/rets.length);
  const reg=regression(cl,30),slopePct=reg?reg.sl/px*100:0;
  const w=cl.slice(-21);let path=0;for(let i=1;i<w.length;i++)path+=Math.abs(w[i]-w[i-1]);const er=path?Math.abs(w[w.length-1]-w[0])/path:0;
  const ap=A.map((a,i)=>a?a/bars[i].close:null),med=pctile(ap.slice(-60),.5)||atr/px,vr=(atr/px)/med;
  const e9=ema(cl,9),e21=ema(cl,21),rs=rsiArr(cl)[n-1]||50;
  let name='CHOP',conf=clamp((.3-er)/.3*100,20,90);
  if(vr>1.7){name='VOLATILE';conf=clamp((vr-1.7)*80+55,50,95)}
  else if(er>.38&&slopePct>0){name='TREND UP';conf=clamp(er*130,40,98)}else if(er>.38&&slopePct<0){name='TREND DOWN';conf=clamp(er*130,40,98)}
  const lv=levels(bars.slice(-80),atr),sup=lv.filter(l=>l.p<px).sort((a,b)=>b.p-a.p)[0],res=lv.filter(l=>l.p>px).sort((a,b)=>a.p-b.p)[0];
  const stU=trend(bars[n-2],bars[n-1]);
  const L=clamp((stU==='UP'?30:stU==='NONE'?10:0)+(e9[n-1]>e21[n-1]?15:0)+(px>e21[n-1]?10:0)+(rs>50&&rs<72?15:rs>=72?5:0)+(name==='TREND UP'?25:name==='CHOP'?8:0)+(slopePct>0?5:0),0,100);
  const Sh=clamp((stU==='DOWN'?30:stU==='NONE'?10:0)+(e9[n-1]<e21[n-1]?15:0)+(px<e21[n-1]?10:0)+(rs<50&&rs>28?15:rs<=28?5:0)+(name==='TREND DOWN'?25:name==='CHOP'?8:0)+(slopePct<0?5:0),0,100);
  const side=L>=Sh+10?'long':Sh>=L+10?'short':null;
  let plan=null;const mx=cfg.maxStopPct/100*px;
  if(side==='long'){let st=sup?sup.p-.25*atr:px-1.5*atr;st=clamp(st,px-mx,px-.8*atr);const r=px-st;let tg=res&&res.p-px>=1.5*r?res.p-.1*atr:px+2*r;plan={side,stop:st,target:tg}}
  if(side==='short'){let st=res?res.p+.25*atr:px+1.5*atr;st=clamp(st,px+.8*atr,px+mx);const r=st-px;let tg=sup&&px-sup.p>=1.5*r?sup.p+.1*atr:px-2*r;plan={side,stop:st,target:tg}}
  return{atr,atrPct:atr/px*100,sig,er,vr,slopePct,name,conf,L,S:Sh,sup,res,levels:lv,rsi:rs,e9,e21,plan,side,reg,
    next:[px-.9*atr,px+.9*atr],c1:[px*Math.exp(-sig),px*Math.exp(sig)],c2:[px*Math.exp(-2*sig),px*Math.exp(2*sig)],A};
}
return { engine, atrArr, ema, rsiArr, clamp };
}
const FEATURES = [
  ['regime', 'Regime score gate', 'Scores every setup (trend, EMAs, RSI, regime) and skips weak ones'],
  ['lossbar', 'Loss-raised entry bar', 'Raises the score bar +5 for each consecutive loss'],
  ['countertrend', 'Counter-trend veto', 'Blocks longs in a down-trend and shorts in an up-trend unless the score is exceptional'],
  ['regimelearn', 'Regime sit-out', 'Sits out a regime that keeps losing (avg below -0.25R over 6+ trades)'],
  ['hourlearn', 'Hour-of-day learning', 'Skips UTC hours that have lost money (avg below -0.3R over 8+ trades)'],
  ['sidelearn', 'Side x regime sizing', 'Sizes down the side/regime combinations that have been losing'],
  ['confsize', 'Confidence sizing', 'Sizes each trade 0.6x to 1.3x by its score, less in volatile markets'],
  ['expectancy', 'Expectancy sizing', 'Scales size by the last 20 trades expectancy (Kelly-lite)'],
  ['ddsize', 'Drawdown-aware sizing', 'Shrinks size as the session drawdown grows'],
  ['volspike', 'Volatility-spike guard', 'Skips entries when volatility is above 3.5x normal, trims size above 2.2x'],
  ['cost', 'Cost guard', 'Skips when the expected candle range is below 2x spread + fees'],
  ['liquidity', 'Liquidity guard', 'Caps size to a third of the order-book depth near the price'],
  ['divergence', 'AMM / book divergence', 'Skips when the AMM and order book disagree by more than 1%'],
  ['refcheck', 'Outside price check', 'Pauses entries when the XRPL price is >3% away from Bitstamp'],
  ['mtf', 'Higher-timeframe confirm', 'Blocks entries against a strong 3x-timeframe trend'],
  ['imbalance', 'Order-book imbalance', 'Trims size when the book leans against the trade, adds when it leans with it'],
  ['sr', 'Support / resistance filter', 'Skips when the next level is closer than 1R'],
  ['exits', 'Regime exit profiles', 'Picks trailing exits per regime: ATR trail in trends, tight % trail in chop'],
  ['adaptivetp', 'Adaptive take-profit', 'Scales the profit target by regime'],
  ['timestop', 'Time stop', 'Closes flat chop trades that go nowhere after N candles'],
  ['limitlearn', 'Limit aggressiveness learning', 'Starts limit orders closer to the market when they keep missing'],
  ['slipLearn', 'Slippage learning', 'Sets market-order slippage from the slippage you actually got'],
  ['retune', 'Auto re-tune', 'Re-optimises settings every 150 candles on out-of-sample data'],
  ['eqcurve', 'Equity-curve filter', 'Halves size while the last 8 trades are net down more than 2.5R'],
  ['stale', 'Stale-data guard', 'Skips entries when prices or ledgers have stopped updating'],
].map(([id, name, desc]) => ({ id, name, desc }));

class Brain {
  constructor() { this.hits = {}; this.reset(); this.lastDecision = ''; this.lastTune = null; this.acfg = {}; this.eng = null; }
  reset() { this.reg = {}; this.sideReg = {}; this.hour = {}; this.fill = []; this.slip = []; this.recent = []; }
  engine(cfg) { if (!this.eng || this.engCfg !== cfg.maxStopPct) { this.eng = buildEngine(cfg); this.engCfg = cfg.maxStopPct; } return this.eng; }
  on(cfg, id) { return cfg.smart !== false && !(cfg.smartOff || []).includes(id); }
  hit(id) { this.hits[id] = (this.hits[id] || 0) + 1; }
  // ---- learning ----
  learn(t) {
    if (!t || t.r == null || !isFinite(t.r)) return; const w = t.pnl > 0 ? 1 : 0;
    if (t.reg) { const g = (this.reg[t.reg] ||= { n: 0, w: 0, r: 0 }); g.n++; g.w += w; g.r += t.r; const k = t.reg + '|' + t.side, s = (this.sideReg[k] ||= { n: 0, r: 0 }); s.n++; s.r += t.r; }
    const h = new Date(t.t).getUTCHours(), x = (this.hour[h] ||= { n: 0, r: 0 }); x.n++; x.r += t.r;
    this.recent.push(t.r); if (this.recent.length > 20) this.recent.shift();
  }
  rebuild(trades) { this.reset(); for (const t of trades) this.learn(t); }
  recordFill(ok) { this.fill.push(ok ? 1 : 0); if (this.fill.length > 12) this.fill.shift(); }
  recordSlip(pct) { if (isFinite(pct)) { this.slip.push(Math.max(0, pct)); if (this.slip.length > 30) this.slip.shift(); } }
  limitFrac(cfg) { const base = cfg.limitSpreadFrac ?? 0.3; if (!this.on(cfg, 'limitlearn') || this.fill.length < 4) return base; const miss = 1 - this.fill.reduce((a, b) => a + b, 0) / this.fill.length; if (miss >= 0.8) return Math.max(base, 0.9); if (miss >= 0.5) return Math.max(base, 0.6); if (miss === 0) return Math.min(base, 0.2); return base; }
  slipPct(cfg) { const b = cfg.entrySlippagePct; if (!this.on(cfg, 'slipLearn') || this.slip.length < 5) return b; const avg = this.slip.reduce((a, c) => a + c, 0) / this.slip.length; return Math.min(1.5, Math.max(0.15, avg * 2.5)); }
  // direction hint for always-in mode: regime + MTF
  regimeVote(bars, px, cfg) { try { const E = this.engine(cfg).engine(bars, px); if (!E) return 0; return E.name === 'TREND UP' ? 1 : E.name === 'TREND DOWN' ? -1 : (E.L - E.S) / 100; } catch { return 0; } }
  // ---- the decision ----
  evaluate(inp) {
    const { long, px, stop, closed, cfg, snap = {}, sess = {}, relaxed, orderQuote } = inp, side = long ? 'long' : 'short', side2 = long ? 'LONG' : 'SHORT';
    const on = id => this.on(cfg, id), veto = (id, why) => { this.hit(id); this.lastDecision = `${side} blocked · ${why}`; return { ok: false, why: `${FEATURES.find(f => f.id === id).name}: ${why}`, id }; };
    if (cfg.smart === false) return { ok: true, size: 1, ov: null, reg: null };
    let size = 1, notes = [], ov = null, E = null, reg = '—', score = 50;
    const nowH = new Date().getUTCHours();
    // stale / outside feed checks first (these protect against trading on bad data)
    if (on('stale') && ((snap.tickAgeMs || 0) > 20000 || (snap.ledgerAgeMs || 0) > 30000)) return veto('stale', `data is ${Math.round(Math.max(snap.tickAgeMs || 0, snap.ledgerAgeMs || 0) / 1000)}s old`);
    if (on('refcheck') && snap.refDev != null && Math.abs(snap.refDev) > 3) return veto('refcheck', `XRPL price is ${snap.refDev.toFixed(1)}% from Bitstamp`);
    if (on('divergence') && snap.amm && snap.bookBid && snap.bookAsk) { const mid = (snap.bookBid + snap.bookAsk) / 2, d = Math.abs(snap.amm - mid) / mid * 100; if (d > 1) return veto('divergence', `AMM and book are ${d.toFixed(2)}% apart`); }
    try { E = this.engine(cfg).engine(closed, px); } catch { E = null; }
    if (E) {
      reg = E.name; score = long ? E.L : E.S; const risk = Math.abs(px - stop), consec = sess.consec || 0;
      let thr = 52 + (on('lossbar') ? Math.min(3, consec) * 5 : 0) + (E.name === 'VOLATILE' ? 8 : 0); if (relaxed) thr *= 0.55;
      if (on('countertrend') && ((long && E.name === 'TREND DOWN') || (!long && E.name === 'TREND UP')) && score < 85) return veto('countertrend', `${side} against ${E.name}`);
      if (on('regime') && score < thr) return veto('regime', `${side} score ${Math.round(score)} < ${Math.round(thr)}`);
      const rg = this.reg[E.name]; if (on('regimelearn') && rg && rg.n >= 6 && rg.r / rg.n < -0.25) return veto('regimelearn', `${E.name} averages ${(rg.r / rg.n).toFixed(2)}R`);
      const hg = this.hour[nowH]; if (on('hourlearn') && hg && hg.n >= 8 && hg.r / hg.n < -0.3) return veto('hourlearn', `${nowH}:00 UTC averages ${(hg.r / hg.n).toFixed(2)}R`);
      if (on('volspike')) { if (E.vr > 3.5) return veto('volspike', `volatility ${E.vr.toFixed(1)}x normal`); if (E.vr > 2.2) { size *= 0.7; this.hit('volspike'); notes.push('vol x0.7'); } }
      const spreadPct = snap.ask && snap.bid ? (snap.ask - snap.bid) / px * 100 : 0;
      if (on('cost') && E.atrPct < 2 * spreadPct + 0.06) return veto('cost', `range ${E.atrPct.toFixed(3)}% below costs ${(2 * spreadPct + 0.06).toFixed(3)}%`);
      if (on('sr')) { if (long && E.res && E.res.p > px && E.res.p - px < risk) return veto('sr', `resistance ${E.res.p.toPrecision(5)} inside 1R`); if (!long && E.sup && E.sup.p < px && px - E.sup.p < risk) return veto('sr', `support ${E.sup.p.toPrecision(5)} inside 1R`); }
      if (on('mtf')) { try { const h = STRAT.aggregate(closed, null, 3); if (h.length >= 26) { const H = this.engine(cfg).engine(h, px); if (H && H.er > 0.45 && ((long && H.name === 'TREND DOWN') || (!long && H.name === 'TREND UP'))) return veto('mtf', `3x timeframe is ${H.name}`); } } catch {} }
      if (on('confsize')) { const m = Math.max(0.6, Math.min(1.3, 0.6 + (score - 50) / 70)) * (E.name === 'VOLATILE' ? 0.6 : 1); size *= m; notes.push('conf x' + m.toFixed(2)); }
      const sr = this.sideReg[E.name + '|' + side2]; if (on('sidelearn') && sr && sr.n >= 5) { const m = Math.max(0.5, Math.min(1.2, 1 + (sr.r / sr.n) * 0.5)); if (m < 1) this.hit('sidelearn'); size *= m; }
      const tr = E.name.startsWith('TREND'), vol = E.name === 'VOLATILE';
      ov = {};
      if (on('exits')) Object.assign(ov, tr ? { trailMode: 'atr', atrMult: 2.4, givebackPct: 35, givebackAfterR: 2 } : vol ? { trailMode: 'atr', atrMult: 3 } : { trailMode: 'pct', trailPct: 0.7, trailActivateR: 0.7 });
      if (on('adaptivetp')) ov.takeProfitR = tr ? 0 : vol ? 1.5 : 1.3;
      if (on('timestop') && !tr) ov.timeStopBars = vol ? 10 : 12;
      if (!Object.keys(ov).length) ov = null;
    } else notes.push('warming up (no regime yet)');
    if (on('expectancy') && this.recent.length >= 10) { const x = this.recent.reduce((a, b) => a + b, 0) / this.recent.length; if (x < -0.2) { size *= 0.6; this.hit('expectancy'); notes.push('expectancy x0.6'); } else if (x > 0.3) { size *= 1.15; notes.push('expectancy x1.15'); } }
    if (on('eqcurve') && this.recent.length >= 8) { const s = this.recent.slice(-8).reduce((a, b) => a + b, 0); if (s < -2.5) { size *= 0.5; this.hit('eqcurve'); notes.push('equity curve x0.5'); } }
    if (on('ddsize') && sess.ddPct > 1.5) { const m = 1 - Math.min(0.6, (sess.ddPct - 1.5) / 10); size *= m; this.hit('ddsize'); notes.push('drawdown x' + m.toFixed(2)); }
    if (on('imbalance') && snap.depthBid > 0 && snap.depthAsk > 0) { const imb = (snap.depthBid - snap.depthAsk) / (snap.depthBid + snap.depthAsk), a = long ? imb : -imb; if (a < -0.5) { size *= 0.7; this.hit('imbalance'); notes.push('book against x0.7'); } else if (a > 0.5) { size = Math.min(size * 1.1, 1.3); notes.push('book with x1.1'); } }
    if (on('liquidity') && orderQuote > 0) { const d = long ? snap.depthAsk : snap.depthBid; if (d > 0) { const cap = d / 3 / orderQuote; if (cap < 0.1) return veto('liquidity', `book depth ${d.toFixed(2)} too thin for ${orderQuote.toFixed(2)}`); if (cap < size) { size = cap; this.hit('liquidity'); notes.push('depth cap x' + cap.toFixed(2)); } } }
    size = Math.max(0.05, Math.min(1.5, size));
    this.lastDecision = `${reg} · ${side} score ${Math.round(score)} · size x${size.toFixed(2)}${notes.length ? ' · ' + notes.join(', ') : ''}`;
    return { ok: true, size, ov, reg, score, notes };
  }
  retune(closed, cfg, apply) {
    if (!this.on(cfg, 'retune') || closed.length < 220) return;
    try { const o = STRAT.optimize(closed.slice(-500), { ...cfg, ...this.acfg }), w = o && o.rows && o.rows[0];
      if (w && w.oos && w.oos.n >= 5 && w.oos.pf > 1.2) { this.acfg = { ...this.acfg, ...w.g }; this.lastTune = 'candle ' + closed.length + ': ' + Object.entries(w.g).map(([k, v]) => k + ' ' + v).join(', ') + ' (out-of-sample PF ' + w.oos.pf.toFixed(2) + ')'; this.hit('retune'); apply && apply(this.acfg, this.lastTune); }
      else this.lastTune = 'candle ' + closed.length + ': no better out-of-sample settings, kept current'; } catch (e) { this.lastTune = 'retune failed: ' + e.message; }
  }
  view(cfg, consec) {
    const rg = Object.entries(this.reg).map(([k, v]) => ({ name: k, n: v.n, win: v.w / Math.max(1, v.n) * 100, r: v.r / Math.max(1, v.n) }));
    return { on: cfg.smart !== false, last: this.lastDecision, bar: 52 + (this.on(cfg, 'lossbar') ? Math.min(3, consec || 0) * 5 : 0), tune: this.lastTune, reg: rg, features: FEATURES.map(f => ({ ...f, on: this.on(cfg, f.id), hits: this.hits[f.id] || 0 })), fillMiss: this.fill.length ? Math.round((1 - this.fill.reduce((a, b) => a + b, 0) / this.fill.length) * 100) : null, slip: this.slip.length ? this.slip.reduce((a, c) => a + c, 0) / this.slip.length : null };
  }
}
module.exports = { Brain, FEATURES, buildEngine };
