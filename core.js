/* Pensioenplan — rekenkern.
   Puur JavaScript zonder DOM: leest exports in (Degiro CSV, Revolut-afschrift) en rekent
   alles uit wat het dashboard toont. Werkt in de browser en is los te testen. */
(function (root) {
  "use strict";
  const PP = {};
  const DAY = 864e5;

  /* ------------------------------------------------------------------ helpers */
  PP.num = function (s) {
    s = s == null ? "" : String(s).trim();
    if (!s) return 0;
    if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
    const v = parseFloat(s);
    return isNaN(v) ? 0 : v;
  };
  PP.dEU = function (s) {
    const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(s || "").trim());
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  };
  PP.csv = function (text) {
    text = String(text || "").replace(/^﻿/, "");
    const rows = []; let row = [], f = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(f); f = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(f); rows.push(row); row = []; f = "";
      } else f += c;
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    return rows.filter(r => r.length > 1 || r[0] !== "");
  };
  // stabiele hash (cyrb53) voor import-id's, zodat dezelfde regel nooit dubbel binnenkomt
  PP.hash = function (str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
  };
  // identieke regels in één bestand (bv. correcties) krijgen een volgnummer
  function counter() { const seen = {}; return k => { seen[k] = (seen[k] || 0) + 1; return k + "#" + seen[k]; }; }
  const looksEtf = name => /\b(ETF|UCITS|ETC|ETN|INDEX FUND)\b/i.test(name || "");

  /* ------------------------------------------------------------------ bestandsherkenning */
  PP.detect = function (name, text) {
    if (/\.pdf$/i.test(name || "")) return "revolut-pdf";
    const head = String(text || "").replace(/^﻿/, "").split(/\r?\n/)[0].toLowerCase();
    if (/omschrijving|description|beschreibung/.test(head) && /saldo|balance/.test(head)) return "degiro-account";
    if (/(aantal|quantity|anzahl)/.test(head) && /(koers|price|kurs)/.test(head)) return "degiro-trades";
    return null;
  };

  /* ------------------------------------------------------------------ Degiro rekeningoverzicht */
  PP.parseDegiroAccount = function (text) {
    const rows = PP.csv(text); rows.shift();
    const key = counter(), cash = [], instruments = {};
    let read = 0;
    rows.forEach(r => {
      if (r.length < 9) return;
      const date = PP.dEU(r[0]); if (!date) return;
      read++;
      const desc = (r[5] || "").trim(), d = desc.toLowerCase();
      const cur = (r[7] || "EUR").trim() || "EUR", amt = PP.num(r[8]);
      const isin = (r[4] || "").trim(), prod = (r[3] || "").trim();
      let kind = null;
      if (d === "ideal deposit" || d === "storting" || d === "deposit" || d === "sofort deposit" || d === "bancontact deposit" || d.startsWith("flatex storting")) kind = "deposit";
      else if (d.startsWith("terugstorting") || d === "withdrawal" || d.startsWith("flatex terugstorting")) kind = "withdrawal";
      else if (d === "dividend" || d === "kapitaalsuitkering" || d === "capital return") kind = "dividend";
      else if (d === "dividendbelasting" || d === "dividend tax") kind = "divtax";
      else if (d.startsWith("degiro aansluitingskosten") || d.startsWith("degiro exchange connection fee") || d.startsWith("adr/gdr") || d.startsWith("degiro service fee") || d.startsWith("degiro servicekosten")) kind = "fee";
      else if (d.includes("promotie") || d.includes("promotion")) kind = "promo";
      else if (d.includes("interest") && amt !== 0) kind = "interest";
      if (!kind || amt === 0) return;
      const raw = [r[0], r[1], r[2], prod, isin, desc, cur, r[8]].join("|");
      cash.push({ ext_id: "dga-" + PP.hash(key(raw)), broker: "Degiro", date, kind, ikey: isin || null, amount: amt, currency: cur });
      if (isin && !instruments[isin]) instruments[isin] = { key: isin, isin, name: prod };
    });
    return { kind: "degiro-account", read, trades: [], cash, instruments: Object.values(instruments) };
  };

  /* ------------------------------------------------------------------ Degiro transacties */
  PP.parseDegiroTrades = function (text) {
    const rows = PP.csv(text); rows.shift();
    const key = counter(), trades = [], instruments = {};
    let read = 0;
    rows.forEach(r => {
      if (r.length < 16) return;
      const date = PP.dEU(r[0]); if (!date) return;
      read++;
      const prod = r[2].trim(), isin = r[3].trim(), exch = r[4].trim();
      const qty = PP.num(r[6]), price = PP.num(r[7]), cur = (r[8] || "").trim();
      const fx = PP.num(r[13]), fee = PP.num(r[14]), total = PP.num(r[15]), oid = (r[16] || "").trim();
      if (!isin || !qty) return;
      const raw = [r[0], r[1], isin, r[6], r[7], r[11], r[14], r[15], oid].join("|");
      trades.push({ ext_id: "dgt-" + PP.hash(key(raw)), broker: "Degiro", date, ikey: isin, qty, price, currency: cur,
        total_eur: total, total_local: null, fee_eur: Math.round(-fee * 100) / 100, fx_eur: Math.round(-fx * 100) / 100, fee_local: 0 });
      instruments[isin] = { key: isin, isin, name: prod, exchange: exch, currency: cur, kind: looksEtf(prod) ? "ETF" : "Aandeel" };
    });
    return { kind: "degiro-trades", read, trades, cash: [], instruments: Object.values(instruments) };
  };

  /* ------------------------------------------------------------------ Revolut afschrift (tekstregels uit de PDF) */
  const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
  function money(s) {
    const m = /^(-)?(US\$|€|£|\$|CHF)?(-)?([\d,]+(?:\.\d+)?)$/.exec(String(s || "").trim());
    if (!m) return null;
    return (m[1] || m[3] ? -1 : 1) * parseFloat(m[4].replace(/,/g, ""));
  }
  PP.parseRevolutLines = function (lines) {
    const key = counter(), isinOf = {}, nameOf = {}, ev = [];
    let sec = null, read = 0;
    lines.forEach(line => {
      const L = String(line).replace(/\s+/g, " ").trim();
      let m;
      if ((m = /^(USD|EUR|GBP) (Transactions|Portfolio breakdown|Account summary)\b/.exec(L))) { sec = { cur: m[1], part: m[2] }; return; }
      if (sec && sec.part === "Portfolio breakdown" && (m = /^([A-Z0-9.]{1,10}) (.+?) ([A-Z]{2}[A-Z0-9]{9}\d) [\d.,]+ /.exec(L))) {
        isinOf[m[1]] = m[3]; nameOf[m[1]] = m[2]; return;
      }
      const dm = /^(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}:\d{2}:\d{2}) GMT (.+)$/.exec(L);
      if (!dm || !sec || sec.part !== "Transactions") return;
      read++;
      const date = `${dm[3]}-${String(MON[dm[2]]).padStart(2, "0")}-${dm[1].padStart(2, "0")}`, rest = dm[5], cur = sec.cur;
      const id = "rev-" + PP.hash(key([date, dm[4], cur, rest].join("|")));
      let t;
      if ((t = /^([A-Z0-9.]+) Trade - \S+(?: \S+)?? ([\d.,]+) (\S+) (Buy|Sell) (\S+) (\S+) (\S+)$/.exec(rest))) {
        ev.push({ type: "trade", id, date, cur, sym: t[1], qty: parseFloat(t[2].replace(/,/g, "")), price: money(t[3]), side: t[4], value: money(t[5]), fees: money(t[6]) || 0, comm: money(t[7]) || 0 });
      } else if ((t = /^Cash top-up (\S+)/.exec(rest))) ev.push({ type: "topup", id, date, cur, amount: money(t[1]) });
      else if ((t = /^Cash withdrawal (\S+)/.exec(rest))) ev.push({ type: "withdrawal", id, date, cur, amount: money(t[1]) });
      else if (/\bDividend\b/i.test(rest)) {
        const sym = (/^([A-Z0-9.]+) /.exec(rest) || [])[1];
        const amt = rest.split(" ").map(money).find(x => x != null && x !== 0);
        if (amt != null) ev.push({ type: /tax/i.test(rest) ? "divtax" : "dividend", id, date, cur, sym: sym && sym !== "Dividend" ? sym : null, amount: amt });
      } else if (/custody fee|service fee/i.test(rest)) {
        const amt = rest.split(" ").map(money).find(x => x != null && x !== 0);
        if (amt != null) ev.push({ type: "fee", id, date, cur, amount: -Math.abs(amt) });
      }
    });
    // EUR-opname + USD-storting op dezelfde dag = interne omwisseling, geen echte storting/opname
    const internal = new Set();
    ev.filter(e => e.type === "withdrawal" && e.cur === "EUR").forEach(w => {
      const top = ev.find(e => e.type === "topup" && e.cur !== "EUR" && e.date === w.date && !internal.has(e.id));
      if (top) { internal.add(w.id); internal.add(top.id); }
    });
    const ik = sym => isinOf[sym] || "REV:" + sym;
    const trades = [], cash = [], instruments = {};
    ev.forEach(e => {
      if (internal.has(e.id)) return;
      if (e.type === "trade") {
        const k = ik(e.sym), cost = (e.fees || 0) + (e.comm || 0), sign = e.side === "Buy" ? 1 : -1;
        const total = e.side === "Buy" ? -(e.value + cost) : e.value - cost;
        trades.push({ ext_id: e.id, broker: "Revolut", date: e.date, ikey: k, qty: sign * e.qty, price: e.price, currency: e.cur,
          total_eur: e.cur === "EUR" ? Math.round(total * 100) / 100 : null, total_local: Math.round(total * 100) / 100, fee_eur: 0, fx_eur: 0, fee_local: Math.round(cost * 100) / 100 });
        if (!instruments[k]) instruments[k] = { key: k, isin: isinOf[e.sym] || null, name: nameOf[e.sym] || e.sym, currency: e.cur,
          yahoo: e.cur === "EUR" ? e.sym + ".DE" : e.cur === "GBP" ? e.sym + ".L" : e.sym, kind: looksEtf(nameOf[e.sym] || "") ? "ETF" : null };
      } else if (e.type === "topup" || e.type === "withdrawal") {
        cash.push({ ext_id: e.id, broker: "Revolut", date: e.date, kind: e.type === "topup" ? "deposit" : "withdrawal", ikey: null, amount: e.amount, currency: e.cur });
      } else {
        cash.push({ ext_id: e.id, broker: "Revolut", date: e.date, kind: e.type, ikey: e.sym ? ik(e.sym) : null, amount: e.amount, currency: e.cur });
      }
    });
    // posities in het overzicht zonder eigen transactie in deze periode: wel ISIN/naam bewaren
    Object.keys(isinOf).forEach(sym => {
      const k = isinOf[sym];
      if (!instruments[k]) instruments[k] = { key: k, isin: k, name: nameOf[sym], currency: null, yahoo: null, kind: looksEtf(nameOf[sym]) ? "ETF" : null };
    });
    return { kind: "revolut-pdf", read, trades, cash, instruments: Object.values(instruments) };
  };

  /* ------------------------------------------------------------------ Yahoo-symbool kiezen bij een ISIN */
  const EXCH = { EAM: ".AS", XET: ".DE", FRA: ".F", EPA: ".PA", MIL: ".MI", LSE: ".L", BRU: ".BR", SWX: ".SW", MAD: ".MC", OMX: ".ST", CSE: ".CO", OSL: ".OL", HEL: ".HE", WSE: ".WA", VIE: ".VI", TDG: ".DE" };
  PP.pickYahoo = function (ins, quotes) {
    if (!quotes || !quotes.length) return null;
    const suf = EXCH[ins.exchange];
    if (suf) { const q = quotes.find(x => x.symbol.endsWith(suf)); if (q) return q.symbol; }
    if (["NDQ", "NSY", "ASE", "BATS", "OTC"].includes(ins.exchange) || ins.currency === "USD") {
      const q = quotes.find(x => !x.symbol.includes(".")); if (q) return q.symbol;
    }
    return quotes[0].symbol;
  };

  /* ------------------------------------------------------------------ de rekenmachine */
  PP.defaults = { goals: { minMonthly: 250, etfKey: null, margin: 1, divFrom: null }, forecast: { rate: 7, inflation: 2 }, benchmark: "SXR8.DE" };

  PP.build = function (data, prices, settings, todayISO) {
    settings = settings || {};
    const G = Object.assign({}, PP.defaults.goals, settings.goals || {});
    const F = Object.assign({}, PP.defaults.forecast, settings.forecast || {});
    const BENCH = settings.benchmark || PP.defaults.benchmark;
    prices = prices || {};
    const INS = {}; (data.instruments || []).forEach(i => { INS[i.key] = i; });
    const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    const trades = (data.trades || []).slice().sort(byDate);
    const cash = (data.cash || []).slice().sort(byDate);
    const flows = cash.filter(c => c.kind === "deposit" || c.kind === "withdrawal");
    if (!trades.length && !flows.length) return null;

    const firstDates = [trades[0] && trades[0].date, flows[0] && flows[0].date].filter(Boolean).sort();
    const start = firstDates[0];
    const lastEvent = [trades.length && trades[trades.length - 1].date, cash.length && cash[cash.length - 1].date].filter(Boolean).sort().pop();
    const end = todayISO > lastEvent ? todayISO : lastEvent;
    const t0 = Date.parse(start + "T00:00:00Z");
    const n = Math.round((Date.parse(end + "T00:00:00Z") - t0) / DAY) + 1;
    const iso = i => new Date(t0 + i * DAY).toISOString().slice(0, 10);
    const ix = d => Math.max(0, Math.min(n - 1, Math.round((Date.parse(d + "T00:00:00Z") - t0) / DAY)));

    // dagkoersen, doorgetrokken over weekenden en feestdagen
    const dailyCache = {};
    function daily(sym) {
      if (dailyCache[sym] !== undefined) return dailyCache[sym];
      const p = prices[sym];
      if (!p || !p.rows || !p.rows.length) return (dailyCache[sym] = null);
      const rows = p.rows.slice().sort((a, b) => (a[0] < b[0] ? -1 : 1));
      const arr = new Array(n); let k = 0, last = null;
      for (let i = 0; i < n; i++) {
        const d = iso(i);
        while (k < rows.length && rows[k][0] <= d) { last = rows[k][1]; k++; }
        arr[i] = last;
      }
      for (let i = 0; i < n && arr[i] == null; i++) arr[i] = rows[0][1];
      return (dailyCache[sym] = arr);
    }
    const fxArr = cur => (cur === "GBp" || cur === "GBX") ? daily("EURGBP=X") : daily(`EUR${cur}=X`);
    function toEur(amount, cur, i) {
      if (!cur || cur === "EUR") return amount;
      let a = amount; if (cur === "GBp" || cur === "GBX") a /= 100;
      const f = fxArr(cur);
      return f ? a / f[Math.max(0, Math.min(n - 1, i))] : a;
    }
    const tEur = t => (t.total_eur != null ? Number(t.total_eur) : toEur(Number(t.total_local || 0), t.currency, ix(t.date)));
    const tFee = t => Number(t.fee_eur || 0) + Number(t.fx_eur || 0) + (t.fee_local ? toEur(Number(t.fee_local), t.currency, ix(t.date)) : 0);
    const cEur = c => toEur(Number(c.amount), c.currency, ix(c.date));

    // koers per positie in euro's (met noodoplossing: laatste handelskoers als er geen koersdata is)
    const pxCache = {}, missing = [];
    function pxEur(key) {
      if (pxCache[key] !== undefined) return pxCache[key];
      const ins = INS[key] || {}, sym = ins.yahoo, d = sym ? daily(sym) : null;
      if (d) { const cur = (prices[sym] && prices[sym].currency) || ins.currency || "EUR"; return (pxCache[key] = d.map((v, i) => toEur(v, cur, i))); }
      missing.push(key);
      const arr = new Array(n).fill(null); let last = null;
      const tt = trades.filter(t => t.ikey === key);
      let k = 0;
      for (let i = 0; i < n; i++) {
        const d2 = iso(i);
        while (k < tt.length && tt[k].date <= d2) { const t = tt[k]; if (t.qty) last = Math.abs(tEur(t)) / Math.abs(t.qty); k++; }
        arr[i] = last;
      }
      const first = arr.find(v => v != null) || 0;
      for (let i = 0; i < n && arr[i] == null; i++) arr[i] = first;
      return (pxCache[key] = arr);
    }
    const bmRaw = daily(BENCH);
    const bmCur = (prices[BENCH] && prices[BENCH].currency) || "EUR";
    const bm = bmRaw ? bmRaw.map((v, i) => toEur(v, bmCur, i)) : null;

    // dag voor dag: posities, cash, inleg, schaduwportfolio
    const evT = {}, evC = {};
    trades.forEach(t => { (evT[ix(t.date)] = evT[ix(t.date)] || []).push(t); });
    cash.forEach(c => { (evC[ix(c.date)] = evC[ix(c.date)] || []).push(c); });
    const qty = {}; let bal = 0, dep = 0, bmU = 0;
    const V = new Array(n), DEP = new Array(n), BM = new Array(n), IDX = new Array(n), BMI = new Array(n);
    for (let i = 0; i < n; i++) {
      (evT[i] || []).forEach(t => { qty[t.ikey] = (qty[t.ikey] || 0) + Number(t.qty); bal += tEur(t); });
      (evC[i] || []).forEach(c => {
        const e = cEur(c); bal += e;
        if (c.kind === "deposit" || c.kind === "withdrawal") { dep += e; if (bm) bmU += e / bm[i]; }
      });
      let inv = 0;
      for (const k in qty) { const q = qty[k]; if (Math.abs(q) > 1e-9) inv += q * pxEur(k)[i]; }
      V[i] = inv + bal; DEP[i] = dep; BM[i] = bm ? bmU * bm[i] : dep;
    }
    IDX[0] = 100;
    for (let i = 1; i < n; i++) {
      const flow = DEP[i] - DEP[i - 1];
      IDX[i] = V[i - 1] > 50 ? IDX[i - 1] * (V[i] - flow) / V[i - 1] : IDX[i - 1];
    }
    for (let i = 0; i < n; i++) BMI[i] = bm ? bm[i] / bm[0] * 100 : 100;

    // weergavenaam (ticker) per instrument
    const symOf = {}, used = {};
    Object.keys(Object.assign({}, INS, ...trades.map(t => ({ [t.ikey]: 1 })))).forEach(k => {
      const ins = INS[k] || {};
      let s = ins.yahoo ? ins.yahoo.split(".")[0] : k.startsWith("REV:") ? k.slice(4) : (ins.name || k).replace(/[^A-Za-z]/g, "").slice(0, 5).toUpperCase();
      if (used[s] && used[s] !== k) s = ins.yahoo || k;
      used[s] = k; symOf[k] = s;
    });

    // posities (gemiddelde aankoopprijs)
    const pos = {};
    trades.forEach(t => {
      const e = tEur(t), q = Number(t.qty);
      const p = pos[t.ikey] = pos[t.ikey] || { qty: 0, cost: 0, realized: 0, brokers: {}, first: t.date };
      p.brokers[t.broker] = 1;
      if (q > 0) { p.qty += q; p.cost += -e; }
      else {
        const avg = p.qty > 1e-9 ? p.cost / p.qty : 0, s = -q;
        p.realized += e - avg * s; p.cost -= avg * s; p.qty -= s;
        if (p.qty < 1e-9) { p.qty = 0; p.cost = 0; }
      }
    });
    const divBy = {};
    cash.filter(c => c.kind === "dividend" || c.kind === "divtax").forEach(c => { if (c.ikey) divBy[c.ikey] = (divBy[c.ikey] || 0) + cEur(c); });
    const qtyBefore = (key, d) => trades.filter(t => t.ikey === key && t.date < d).reduce((s, t) => s + Number(t.qty), 0);
    const yearAgo = iso(Math.max(0, n - 1 - 365));
    const fwd = {};
    cash.filter(c => (c.kind === "dividend" || c.kind === "divtax") && c.ikey && c.date > yearAgo).forEach(c => {
      const q = qtyBefore(c.ikey, c.date), cur = pos[c.ikey] ? pos[c.ikey].qty : 0;
      if (q > 0 && cur > 0) fwd[c.ikey] = (fwd[c.ikey] || 0) + cEur(c) / q * cur;
    });
    const L = n - 1;
    const positions = Object.keys(pos).map(k => {
      const p = pos[k], ins = INS[k] || {}, px = pxEur(k)[L], value = p.qty * px;
      const name = ins.name || symOf[k];
      const kind = ins.kind || (looksEtf(name) ? "ETF" : "Aandeel");
      const sym = ins.yahoo;
      return { key: k, isin: ins.isin || null, sym: symOf[k], name: prettyName(name), type: kind,
        sector: ins.sector || (kind === "ETF" ? "ETF" : "Overig"),
        cur: (sym && prices[sym] && prices[sym].currency) || ins.currency || "EUR",
        broker: Object.keys(p.brokers).sort().join("+"), qty: round(p.qty, 8), cost: round(p.cost, 2), value: round(value, 2),
        unreal: round(value - p.cost, 2), realized: round(p.realized, 2), div: round(divBy[k] || 0, 2),
        open: p.qty > 1e-6, first: p.first, fwd: round(fwd[k] || 0, 2), noPrice: missing.includes(k) };
    }).sort((a, b) => b.value - a.value);
    const px = {};
    positions.filter(p => p.open).forEach(p => {
      const s = Math.max(0, ix(p.first));
      px[p.sym] = { start: iso(s), eur: pxEur(p.key).slice(s).map(v => round(v, 3)) };
    });

    // lijsten voor het dashboard
    const depositRows = flows.map(c => ({ id: c.ext_id, d: c.date, b: c.broker, a: round(cEur(c), 2), note: c.note || "", src: c.source === "manual" ? "man" : "export", kind: c.kind }));
    const dividends = cash.filter(c => c.kind === "dividend" || c.kind === "divtax").map(c => {
      const e = cEur(c);
      return [c.date, c.ikey ? symOf[c.ikey] || "" : "", c.kind === "dividend" ? round(e, 4) : 0, c.kind === "divtax" ? round(e, 4) : 0];
    });
    const tradesOut = trades.map(t => [t.date, t.broker, symOf[t.ikey], Number(t.qty), Number(t.price || 0), t.currency || "EUR", round(tEur(t), 2), round(tFee(t), 2)]);
    const fees = { trans: 0, fx: 0, other: 0, promo: 0, revolut: 0, orders: 0 };
    const orders = {};
    trades.forEach(t => {
      if (t.broker === "Revolut") fees.revolut += tFee(t); else { fees.trans += Number(t.fee_eur || 0); fees.fx += Number(t.fx_eur || 0); }
      orders[[t.broker, t.date, t.ikey, Math.sign(t.qty)].join("|")] = 1;
    });
    fees.orders = Object.keys(orders).length;
    const feesOther = [];
    cash.forEach(c => {
      if (c.kind === "fee") { const e = -cEur(c); fees.other += e; feesOther.push([c.date, round(e, 2)]); }
      if (c.kind === "promo") fees.promo += cEur(c);
    });
    for (const k in fees) if (k !== "orders") fees[k] = round(fees[k], 2);

    // statistieken
    const xirr = endValue => {
      const fl = flows.map(c => [c.date, -cEur(c)]).concat([[end, endValue]]);
      const d0 = Date.parse(fl[0][0]);
      const npv = r => fl.reduce((s, [d, a]) => s + a / Math.pow(1 + r, (Date.parse(d) - d0) / (365.25 * DAY)), 0);
      let lo = -0.95, hi = 10;
      if (npv(lo) * npv(hi) > 0) return null;
      for (let k = 0; k < 200; k++) { const mid = (lo + hi) / 2; if (npv(mid) > 0) lo = mid; else hi = mid; }
      return (lo + hi) / 2 * 100;
    };
    const year = +end.slice(0, 4);
    const y0 = Math.max(0, ix(`${year - 1}-12-31`));
    let peak = 0, mdd = 0, mddI = 0;
    IDX.forEach((v, i) => { peak = Math.max(peak, v); const dd = v / peak - 1; if (dd < mdd) { mdd = dd; mddI = i; } });
    const stats = { xirr: round(xirr(V[L]), 2), xirr_bm: round(xirr(BM[L]), 2), ytd: round((IDX[L] / IDX[y0] - 1) * 100, 2), ytd_bm: round((BMI[L] / BMI[y0] - 1) * 100, 2), mdd: round(mdd * 100, 2), mdd_d: iso(mddI) };

    // dividenddoel: gekozen ETF, of anders de open positie met het meeste dividend
    let etfKey = G.etfKey && pos[G.etfKey] ? G.etfKey : null;
    if (!etfKey) { const c = positions.filter(p => p.open).sort((a, b) => b.div - a.div)[0]; etfKey = c ? c.key : null; }
    const etfP = etfKey ? positions.find(p => p.key === etfKey) : null;
    const goals = { minMonthly: Number(G.minMonthly) || 0, margin: Number(G.margin) || 0, divFrom: Number(G.divFrom) || year,
      etfKey, etf: etfP ? etfP.sym : "—", etfName: etfP ? etfP.name : "—", etfPrice: etfP ? round(pxEur(etfKey)[L], 2) : 0 };

    // koersdatum en instrumentenlijst voor het Data-scherm
    let priceAsof = null;
    positions.filter(p => p.open).forEach(p => {
      const s = (INS[p.key] || {}).yahoo, rows = s && prices[s] && prices[s].rows;
      if (rows && rows.length) { const d = rows[rows.length - 1][0]; if (!priceAsof || d > priceAsof) priceAsof = d; }
    });
    const instruments = Object.keys(pos).map(k => {
      const ins = INS[k] || {}, rows = ins.yahoo && prices[ins.yahoo] && prices[ins.yahoo].rows;
      return { key: k, isin: ins.isin || null, name: prettyName(ins.name || symOf[k]), yahoo: ins.yahoo || "", kind: ins.kind || (looksEtf(ins.name) ? "ETF" : "Aandeel"),
        sector: ins.sector || "", open: pos[k].qty > 1e-6, last: rows && rows.length ? rows[rows.length - 1] : null,
        cur: (ins.yahoo && prices[ins.yahoo] && prices[ins.yahoo].currency) || ins.currency || "" };
    }).sort((a, b) => (b.open - a.open) || a.name.localeCompare(b.name));
    const brokers = [];
    trades.concat(flows).sort(byDate).forEach(x => { if (!brokers.includes(x.broker)) brokers.push(x.broker); });

    return {
      asof: end, start, priceAsof, benchmark: BENCH, benchMissing: !bm,
      series: V.map((v, i) => [round(v, 2), round(DEP[i], 2), round(BM[i], 2), round(BM[i], 2), round(IDX[i], 3), round(BMI[i], 3)]),
      positions, px, deposits: depositRows.map(r => [r.d, r.b, r.a]), depositRows, dividends, trades: tradesOut,
      fees, feesOther, stats, goals, forecast: { rate: Number(F.rate) || 7, inflation: Number(F.inflation) || 0 },
      brokers, instruments, missing: missing.map(k => (INS[k] && INS[k].name) || k)
    };
  };

  function round(v, d) { if (v == null || !isFinite(v)) return v == null ? null : 0; const p = Math.pow(10, d); return Math.round(v * p) / p; }
  // "VANGUARD FTSE ALL-WORLD UCITS ETF USD DIS" -> "Vanguard FTSE All-World UCITS ETF USD Dis"
  function prettyName(s) {
    s = String(s || "");
    if (s !== s.toUpperCase()) return s;
    const keep = /^(ETF|ETC|UCITS|USD|EUR|GBP|FTSE|MSCI|S&P|ADR|NV|N\.V\.|SA|AG|SE|PLC|II|III|ESG|REIT|JPM|MS|DIS|ACC|DIST|DEV|NVIDIA|ASR)$/;
    const brand = { VANECK: "VanEck", ISHARES: "iShares", PAYPAL: "PayPal", SOFI: "SoFi", SPDR: "SPDR", WISDOMTREE: "WisdomTree", XTRACKERS: "Xtrackers" };
    return s.toLowerCase().replace(/(^|[\s\-\/(])([a-z])/g, (m, a, b) => a + b.toUpperCase())
      .split(" ").map(w => { const u = w.toUpperCase().replace(/[(),.]/g, ""); return brand[u] || (keep.test(u) ? w.toUpperCase() : w); }).join(" ")
      .replace(/^ADR On /i, "").replace(/,? Inc\.?(?=\s|$)/gi, "").replace(/ Corporation$/i, "").replace(/ (Holdings?|Group Holding) Limited$/i, "")
      .replace(/ Holdings?,?$/i, "").replace(/ N\.V\.$/i, "").replace(/,$/, "").trim();
  }
  PP.prettyName = prettyName;

  root.PP = PP;
})(typeof window !== "undefined" ? window : globalThis);
