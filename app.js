/* Pensioenplan — app: inloggen, gegevens, koersen, import en het dashboard zelf. */
(function () {
const SUPABASE_URL = "https://libwmmhfnicwzodcnfra.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxpYndtbWhmbmljd3pvZGNuZnJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUwNjYwMTksImV4cCI6MjEwMDY0MjAxOX0.rC42sKZhkUk5dVC6iECMOHm_3hTHT7FJoGAsWcAV7ro";
const FN_URL = SUPABASE_URL + "/functions/v1/pp-prices";
const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
const PP = window.PP;
const MOCK = window.PP_MOCK || null;
const $ = id => document.getElementById(id);
let sb = null, USER = null, RAW = null, PRICES = {}, SETTINGS = {}, IMPORTS = [], PRICE_ERR = null;

function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
function todayISO() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function loader(txt) { $("loader").hidden = false; $("loaderTxt").textContent = txt; }
let toastT = 0;
function toast(msg, ms) { const t = $("toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), ms || 3000); }

/* ------------------------------------------------------------------ opstarten & inloggen */
async function boot() {
  if (MOCK) {
    USER = { id: "mock", email: MOCK.email || "test@lokaal" };
    RAW = MOCK.raw; PRICES = MOCK.prices || {}; SETTINGS = MOCK.settings || {}; IMPORTS = MOCK.imports || [];
    return start();
  }
  if (!window.supabase || !PP) { loader("Kan de app niet laden. Controleer je internetverbinding en ververs de pagina."); return; }
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  let recovering = /type=recovery/.test(location.hash);
  sb.auth.onAuthStateChange(ev => {
    if (ev === "PASSWORD_RECOVERY") { recovering = true; showRecover(); }
    if (ev === "SIGNED_OUT") location.replace(location.pathname);
  });
  const { data: { session } } = await sb.auth.getSession();
  if (recovering) return showRecover();
  if (!session) return showLogin();
  USER = session.user;
  await load();
}

function authMsg(id, txt, kind) { const m = $(id); m.hidden = !txt; m.textContent = txt || ""; m.className = "msg " + (kind || ""); }
function showLogin() {
  $("loader").hidden = true; $("auth").hidden = false; $("loginForm").hidden = false; $("recoverForm").hidden = true;
  $("lEmail").focus();
  $("loginForm").onsubmit = async e => {
    e.preventDefault(); authMsg("lMsg", "");
    const btn = $("lBtn"); btn.disabled = true; btn.textContent = "Bezig…";
    const { data, error } = await sb.auth.signInWithPassword({ email: $("lEmail").value.trim(), password: $("lPass").value });
    btn.disabled = false; btn.textContent = "Inloggen";
    if (error) { authMsg("lMsg", /invalid login/i.test(error.message) ? "E-mailadres of wachtwoord klopt niet." : error.message, "err"); return; }
    $("lPass").value = ""; $("auth").hidden = true; USER = data.user; await load();
  };
  $("forgot").onclick = async () => {
    const em = $("lEmail").value.trim();
    if (!em) { authMsg("lMsg", "Vul eerst je e-mailadres in.", "err"); return; }
    const { error } = await sb.auth.resetPasswordForEmail(em, { redirectTo: location.origin + location.pathname });
    authMsg("lMsg", error ? error.message : "Check je mail: je krijgt een link om een nieuw wachtwoord te kiezen.", error ? "err" : "ok");
  };
}
function showRecover() {
  $("loader").hidden = true; $("app").hidden = true; $("auth").hidden = false; $("loginForm").hidden = true; $("recoverForm").hidden = false;
  $("recoverForm").onsubmit = async e => {
    e.preventDefault();
    const p1 = $("rPass1").value, p2 = $("rPass2").value;
    if (p1.length < 8) return authMsg("rMsg", "Kies een wachtwoord van minstens 8 tekens.", "err");
    if (p1 !== p2) return authMsg("rMsg", "De twee wachtwoorden zijn niet gelijk.", "err");
    const { error } = await sb.auth.updateUser({ password: p1 });
    if (error) return authMsg("rMsg", error.message, "err");
    authMsg("rMsg", "Je nieuwe wachtwoord is opgeslagen.", "ok");
    setTimeout(() => location.replace(location.pathname), 1200);
  };
}

/* ------------------------------------------------------------------ gegevens ophalen */
async function selectAll(table) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select("*").range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}
async function load() {
  loader("Je gegevens ophalen…");
  try {
    const [ins, tr, ca, pr, se, im] = await Promise.all([
      selectAll("pp_instruments"), selectAll("pp_trades"), selectAll("pp_cash"), selectAll("pp_prices"),
      sb.from("pp_settings").select("data").maybeSingle(),
      sb.from("pp_imports").select("kind,filename,rows,added,created_at").order("created_at", { ascending: false }).limit(12)
    ]);
    RAW = { instruments: ins, trades: tr, cash: ca };
    PRICES = {}; pr.forEach(r => { PRICES[r.symbol] = { currency: r.currency, rows: r.data || [], updated_at: r.updated_at }; });
    SETTINGS = (se.data && se.data.data) || {};
    IMPORTS = im.data || [];
  } catch (e) { loader("Er ging iets mis bij het ophalen van je gegevens: " + (e.message || e)); return; }
  const stale = neededSymbols().filter(isStale);
  if (stale.length) {
    loader("Koersen bijwerken…");
    try { await refreshPrices(stale); }
    catch (e) { PRICE_ERR = "Koersen konden niet worden bijgewerkt (" + (e.message || e) + "). Je ziet de laatst bekende koersen."; }
  }
  start();
}

/* ------------------------------------------------------------------ koersen */
function neededSymbols() {
  const s = new Set(), used = new Set(RAW.trades.map(t => t.ikey)), curs = new Set();
  RAW.instruments.forEach(i => { if (used.has(i.key) && i.yahoo) s.add(i.yahoo); if (i.currency) curs.add(i.currency); });
  s.add(SETTINGS.benchmark || PP.defaults.benchmark);
  RAW.trades.forEach(t => t.currency && curs.add(t.currency));
  RAW.cash.forEach(c => c.currency && curs.add(c.currency));
  Object.values(PRICES).forEach(p => p.currency && curs.add(p.currency));
  curs.forEach(c => { if (c !== "EUR") s.add(c === "GBp" || c === "GBX" ? "EURGBP=X" : `EUR${c}=X`); });
  return [...s];
}
function isStale(sym) {
  const p = PRICES[sym];
  if (!p || !p.rows || !p.rows.length) return true;
  return Date.now() - Date.parse(p.updated_at || 0) > 6 * 36e5;
}
function firstDate() { return RAW.trades.map(t => t.date).concat(RAW.cash.map(c => c.date)).sort()[0] || todayISO(); }
async function callFn(body) {
  if (MOCK) throw new Error("niet beschikbaar in testmodus");
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error("niet ingelogd");
  const r = await fetch(FN_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.access_token, apikey: SUPABASE_KEY }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error("server " + r.status);
  return r.json();
}
async function refreshPrices(syms) {
  const req = {}, f0 = Math.floor(Date.parse(firstDate() + "T00:00:00Z") / 1000) - 20 * 86400;
  syms.forEach(s => {
    const p = PRICES[s], last = p && p.rows && p.rows.length ? p.rows[p.rows.length - 1][0] : null;
    req[s] = last ? Math.floor(Date.parse(last + "T00:00:00Z") / 1000) - 10 * 86400 : f0;
  });
  const j = await callFn({ symbols: req });
  const now = new Date().toISOString(), ups = [], bad = [];
  Object.entries(j.prices || {}).forEach(([s, res]) => {
    if (!res || res.error || !res.rows || !res.rows.length) { bad.push(s); return; }
    const m = new Map(((PRICES[s] && PRICES[s].rows) || []).map(x => [x[0], x[1]]));
    res.rows.forEach(([d, c]) => m.set(d, c));
    const rows = [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    PRICES[s] = { currency: res.currency || (PRICES[s] || {}).currency || null, rows, updated_at: now };
    ups.push({ user_id: USER.id, symbol: s, currency: PRICES[s].currency, data: rows, updated_at: now });
  });
  if (ups.length) { const { error } = await sb.from("pp_prices").upsert(ups, { onConflict: "user_id,symbol" }); if (error) throw error; }
  if (bad.length) PRICE_ERR = `Geen koersen gevonden voor ${bad.join(", ")}. Controleer het koerssymbool onder Data → Effecten.`;
}

/* ------------------------------------------------------------------ importeren */
let pdfLib = null;
function loadScript(src) { return new Promise((ok, fail) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => fail(new Error("kon de PDF-lezer niet laden")); document.head.append(s); }); }
async function pdfLines(file) {
  if (!pdfLib) { await loadScript(PDFJS + "pdf.min.js"); pdfLib = window.pdfjsLib; pdfLib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.js"; }
  const doc = await pdfLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    const items = tc.items.filter(it => it.str && it.str.trim()).map(it => ({ x: it.transform[4], y: it.transform[5], s: it.str }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    let cur = null;
    items.forEach(it => { if (cur && Math.abs(cur.y - it.y) <= 2.5) cur.parts.push(it); else { cur = { y: it.y, parts: [it] }; lines.push(cur); } });
  }
  return lines.map(l => l.parts.sort((a, b) => a.x - b.x).map(p => p.s).join(" ").replace(/\s+/g, " ").trim());
}
async function parseFile(f) {
  if (/\.pdf$/i.test(f.name)) {
    const p = PP.parseRevolutLines(await pdfLines(f));
    if (!p.read) throw new Error("geen Revolut-transacties gevonden in deze PDF");
    return p;
  }
  const text = await f.text(), kind = PP.detect(f.name, text);
  if (kind === "degiro-account") return PP.parseDegiroAccount(text);
  if (kind === "degiro-trades") return PP.parseDegiroTrades(text);
  throw new Error("onbekend bestand: verwacht een Degiro-export (CSV) of een Revolut-afschrift (PDF)");
}
async function saveParsed(p, filename) {
  const have = {}; RAW.instruments.forEach(i => { have[i.key] = i; });
  const ins = p.instruments.map(i => {
    const e = have[i.key] || {};
    const name = e.name ? (i.name && i.name.length > e.name.length && i.name.startsWith(e.name) ? i.name : e.name) : (i.name || null);
    return { user_id: USER.id, key: i.key, isin: e.isin || i.isin || null, name, yahoo: e.yahoo || i.yahoo || null,
      currency: e.currency || i.currency || null, kind: e.kind || i.kind || null, sector: e.sector || null, exchange: e.exchange || i.exchange || null };
  });
  const look = ins.filter(i => !i.yahoo && i.isin);
  if (look.length) {
    try { const j = await callFn({ search: look.map(i => i.isin) }); look.forEach(i => { i.yahoo = PP.pickYahoo(i, (j.search || {})[i.isin]) || null; }); }
    catch (e) { /* zonder koerssymbool werkt het dashboard met de aankoopkoers */ }
  }
  if (ins.length) {
    const { error } = await sb.from("pp_instruments").upsert(ins, { onConflict: "user_id,key" });
    if (error) throw error;
    ins.forEach(i => { have[i.key] = Object.assign(have[i.key] || {}, i); });
    RAW.instruments = Object.values(have);
  }
  const up = async (table, rows) => {
    let n = 0;
    for (let k = 0; k < rows.length; k += 400) {
      const chunk = rows.slice(k, k + 400).map(r => Object.assign({ user_id: USER.id }, r));
      const { data, error } = await sb.from(table).upsert(chunk, { onConflict: "user_id,ext_id", ignoreDuplicates: true }).select("ext_id");
      if (error) throw error;
      n += (data || []).length;
    }
    return n;
  };
  const tr = await up("pp_trades", p.trades), ca = await up("pp_cash", p.cash);
  // handmatige stortingen die nu ook in de export staan, worden samengevoegd
  const man = RAW.cash.filter(c => c.source === "manual"), dep = p.cash.filter(c => c.kind === "deposit" || c.kind === "withdrawal"), kill = [];
  for (const m of man) {
    const hit = dep.find(d => d.broker === m.broker && Math.abs(Number(d.amount) - Number(m.amount)) < 0.005 && Math.abs(Date.parse(d.date) - Date.parse(m.date)) <= 4 * 864e5);
    if (hit) { kill.push(m.ext_id); if (m.note) await sb.from("pp_cash").update({ note: m.note }).eq("ext_id", hit.ext_id).is("note", null); }
  }
  if (kill.length) await sb.from("pp_cash").delete().in("ext_id", kill).eq("source", "manual");
  await sb.from("pp_imports").insert({ user_id: USER.id, kind: p.kind, filename: String(filename).slice(0, 120), rows: p.read, added: tr + ca });
  return tr + ca;
}
function setupImport() {
  const zone = $("dropZone"), input = $("fileIn"), log = $("importLog");
  const run = async files => {
    files = [...files]; if (!files.length) return;
    log.replaceChildren(); let added = 0, ok = 0;
    for (const f of files) {
      const li = el("li"), st = el("span", "a", "bezig…");
      li.append(el("i", "key sq"), el("span", null, f.name), el("span", "p", ""), st); log.append(li);
      try {
        const p = await parseFile(f);
        const n = MOCK ? 0 : await saveParsed(p, f.name);
        added += n; ok++;
        st.textContent = `${p.read} regels · ${n} nieuw`; st.className = "a up";
      } catch (e) { st.textContent = e.message || String(e); st.className = "a down"; }
    }
    if (ok) {
      const li = el("li"); const b = el("button", "btn pri", added ? "Dashboard bijwerken" : "Klaar");
      b.onclick = () => location.reload(); li.append(el("span"), el("span", null, added ? `${added} nieuwe regels opgeslagen.` : "Alles stond er al in."), el("span"), b); log.append(li);
    }
  };
  zone.onclick = e => { if (e.target !== input) input.click(); };
  input.onchange = () => { run(input.files); input.value = ""; };
  ["dragenter", "dragover"].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add("drag"); }));
  ["dragleave", "drop"].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove("drag"); }));
  zone.addEventListener("drop", e => run(e.dataTransfer.files));
  const ul = $("imports"); ul.replaceChildren();
  if (!IMPORTS.length) ul.append(el("li", "muted", "Nog geen imports."));
  const KIND = { "degiro-account": "Degiro rekeningoverzicht", "degiro-trades": "Degiro transacties", "revolut-pdf": "Revolut afschrift" };
  IMPORTS.forEach(i => {
    const d = new Date(i.created_at), li = el("li");
    const mid = el("span"); mid.append(document.createTextNode(KIND[i.kind] || i.kind)); const sm = el("div", "muted", i.filename || ""); sm.style.fontSize = "12px"; mid.append(sm);
    li.append(el("i", "key sq"), mid, el("span", "p", d.toLocaleDateString("nl-NL", { day: "numeric", month: "short" })), el("span", "a", `${i.added} nieuw`));
    ul.append(li);
  });
}
function setupAccount() {
  $("accMail").textContent = USER.email || "";
  const av = $("avatarBtn"); av.textContent = (USER.email || "?").slice(0, 1).toUpperCase(); av.onclick = () => { location.hash = "#data"; };
  $("logoutBtn").onclick = async () => { if (MOCK) return toast("Testmodus"); await sb.auth.signOut(); };
  $("backupBtn").onclick = () => {
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), settings: SETTINGS, instruments: RAW.instruments, trades: RAW.trades, cash: RAW.cash }, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `pensioenplan-backup-${todayISO()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
}

/* ------------------------------------------------------------------ acties vanuit het dashboard */
const reloadSoon = () => setTimeout(() => location.reload(), 350);
const CTX = {
  toast,
  priceErr: () => PRICE_ERR,
  settings: () => SETTINGS,
  async saveNote(id, note) {
    if (MOCK) return;
    const { error } = await sb.from("pp_cash").update({ note: note || null }).eq("ext_id", id);
    if (error) throw error;
  },
  async addManual(r) {
    if (MOCK) { toast("Testmodus: niet opgeslagen"); return; }
    const id = "man-" + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(36).slice(2));
    const { error } = await sb.from("pp_cash").insert({ user_id: USER.id, ext_id: id, broker: r.b, date: r.d, kind: r.a >= 0 ? "deposit" : "withdrawal", amount: r.a, currency: "EUR", note: r.note || null, source: "manual" });
    if (error) { toast("Opslaan mislukt: " + error.message); return; }
    toast("Storting opgeslagen"); reloadSoon();
  },
  async deleteManual(id) {
    if (MOCK) { toast("Testmodus: niet verwijderd"); return; }
    const { error } = await sb.from("pp_cash").delete().eq("ext_id", id).eq("source", "manual");
    if (error) { toast("Verwijderen mislukt: " + error.message); return; }
    reloadSoon();
  },
  async saveSettings(next) {
    if (MOCK) { toast("Testmodus: niet opgeslagen"); return; }
    const { error } = await sb.from("pp_settings").upsert({ user_id: USER.id, data: next, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    if (error) { toast("Opslaan mislukt: " + error.message); return; }
    toast("Instellingen opgeslagen"); reloadSoon();
  },
  async saveInstruments(rows) {
    if (MOCK) { toast("Testmodus: niet opgeslagen"); return; }
    const { error } = await sb.from("pp_instruments").upsert(rows.map(r => Object.assign({ user_id: USER.id, updated_at: new Date().toISOString() }, r)), { onConflict: "user_id,key" });
    if (error) { toast("Opslaan mislukt: " + error.message); return; }
    toast("Effecten opgeslagen, koersen worden opgehaald…"); reloadSoon();
  },
  async refreshNow() {
    if (MOCK) { toast("Testmodus"); return; }
    toast("Koersen bijwerken…", 10000);
    try { PRICE_ERR = null; await refreshPrices(neededSymbols()); toast("Koersen bijgewerkt"); reloadSoon(); }
    catch (e) { toast("Bijwerken mislukt: " + (e.message || e), 5000); }
  }
};

/* ------------------------------------------------------------------ starten */
function start() {
  $("loader").hidden = true; $("auth").hidden = true; $("app").hidden = false;
  setupImport(); setupAccount();
  let PF = null;
  try { PF = PP.build(RAW, PRICES, SETTINGS, todayISO()); }
  catch (e) { console.error(e); toast("Rekenfout: " + (e.message || e), 8000); }
  if (!PF) return mountEmpty();
  try { mount(PF, CTX); }
  catch (e) { console.error(e); toast("Er ging iets mis bij het tekenen van het dashboard: " + (e.message || e), 8000); }
}
function mountEmpty() {
  document.querySelectorAll(".tabs a, .tabbar a").forEach(a => { if (a.dataset.nav !== "data") a.hidden = true; });
  document.querySelectorAll(".needs-data").forEach(x => { x.hidden = true; });
  $("welcome").hidden = false;
  document.querySelectorAll(".view").forEach(v => { v.hidden = v.dataset.view !== "data"; });
  $("freshTxt").textContent = "Nog geen gegevens";
}

/* ==================================================================== het dashboard */
function mount(PF, CTX) {
/* =====================================================================
   BASIS
   ===================================================================== */
const $ = id => document.getElementById(id);
const MN = ["jan","feb","mrt","apr","mei","jun","jul","aug","sep","okt","nov","dec"];
const MNF = ["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december"];
const DAY = 864e5;
const START = new Date(PF.start+"T12:00:00");
const N = PF.series.length, LAST = N-1;
const col = k => PF.series.map(r=>r[k]);
const V=col(0), DEP=col(1), BM=col(2), BM2=col(3), IDX=col(4), BMI=col(5);
const dOf = i => new Date(START.getTime()+i*DAY);
const iOf = iso => Math.max(0,Math.min(LAST,Math.round((new Date(iso+"T12:00:00")-START)/DAY)));
const fD = i => { const d=dOf(i); return `${d.getDate()} ${MN[d.getMonth()]} ${d.getFullYear()}`; };
const fDs = iso => { const d=new Date(iso+"T12:00:00"); return `${d.getDate()} ${MN[d.getMonth()]}`; };
const nf = (n,d=0) => Number(n).toLocaleString("nl-NL",{minimumFractionDigits:d,maximumFractionDigits:d});
const eur = (n,d=0) => (n<0?"−":"")+"€"+nf(Math.abs(n),d);
const seur = (n,d=0) => (n>=0?"+":"−")+"€"+nf(Math.abs(n),d);
const pct = (n,d=1) => (n==null||!isFinite(n))?"—":nf(n,d)+"%";
const spct = (n,d=1) => (n==null||!isFinite(n))?"—":(n>=0?"+":"−")+nf(Math.abs(n),d)+"%";
const eurK = n => { const a=Math.abs(n); return a>=1e6?"€"+nf(n/1e6,1)+" mln":a>=1000?"€"+nf(n/1000,a%1000&&a<1e4?1:0)+"k":"€"+nf(n,0); };
const eurR = n => { const a=Math.abs(n); if(a<1000) return eur(Math.round(n/10)*10); const p=Math.pow(10,Math.floor(Math.log10(a))-2); return eur(Math.round(n/p)*p); };
const sum = a => a.reduce((s,x)=>s+(x||0),0);
const dirc = n => n>=0?"up":"down";
const arrow = n => n>=0?"▲":"▼";
function h(tag,cls,txt){ const e=document.createElement(tag); if(cls) e.className=cls; if(txt!=null) e.textContent=txt; return e; }
const NS="http://www.w3.org/2000/svg";
function s(tag,attrs,style){ const e=document.createElementNS(NS,tag); for(const k in attrs) e.setAttribute(k,attrs[k]); if(style) e.setAttribute("style",style); return e; }
function st(x,y,t,anchor,style){ const e=s("text",{x,y,"text-anchor":anchor||"start"},style); e.textContent=t; return e; }
function niceStep(r,c){ const raw=r/c, p=Math.pow(10,Math.floor(Math.log10(raw||1))), n=raw/p; return (n<=1?1:n<=2?2:n<=2.5?2.5:n<=5?5:10)*p; }
function ticks(min,max,c){ const step=niceStep(max-min,c); const lo=Math.floor(min/step)*step, hi=Math.ceil(max/step)*step; const t=[]; for(let v=lo; v<=hi+1e-9; v+=step) t.push(v); return {lo,hi,t}; }
const AX="fill:var(--ink-3);font:11px var(--mono)";
function countUp(el,to,fmt,dur=1100){ const t0=performance.now(); const from=0;
  if(matchMedia("(prefers-reduced-motion: reduce)").matches){ el.textContent=fmt(to); return; }
  (function f(t){ const p=Math.min(1,(t-t0)/dur), e=1-Math.pow(1-p,4); el.textContent=fmt(from+(to-from)*e); if(p<1) requestAnimationFrame(f); })(t0); }
function tip(host,x,y,head,rows){
  let tt=host.querySelector(":scope > .tt"); if(!tt){ tt=h("div","tt"); host.append(tt); }
  tt.replaceChildren(h("div","h",head));
  rows.forEach(r=>{ const row=h("div","r"+(r.tot?" tot":"")), k=h("span","k");
    if(r.c){ const key=h("i","key"+(r.dash?" dash":"")+(r.sq?" sq":"")); key.style.setProperty("--c",r.c); k.append(key); }
    k.append(document.createTextNode(r.n)); const b=h("b",r.cls||null,r.v); row.append(k,b); tt.append(row); });
  const w=tt.offsetWidth, th=tt.offsetHeight, W=host.clientWidth, H=host.clientHeight;
  let l=x+16; if(l+w>W) l=x-16-w; tt.style.left=Math.max(0,l)+"px";
  tt.style.top=Math.max(0,Math.min(H-th,y-th/2))+"px"; tt.classList.add("on");
}
function untip(host){ const tt=host.querySelector(":scope > .tt"); if(tt) tt.classList.remove("on"); }

/* =====================================================================
   AFGELEIDE CIJFERS
   ===================================================================== */
const TODAY = dOf(LAST);
const Y = TODAY.getFullYear();
const POS = PF.positions;
const OPEN = POS.filter(p=>p.open).sort((a,b)=>b.value-a.value);
const INV = sum(OPEN.map(p=>p.value));
const CASH = V[LAST]-INV;
const TOT = V[LAST], DEPT = DEP[LAST], GAIN = TOT-DEPT;
const DIVS = PF.dividends.map(([d,sym,g,t])=>({d,sym,g,t,n:g+t}));
const DIV_NET = sum(DIVS.map(x=>x.n)), DIV_TAX = -sum(DIVS.map(x=>x.t));
const DIV_Y = sum(DIVS.filter(x=>x.d.startsWith(Y)).map(x=>x.n));
const FEES = PF.fees.trans+PF.fees.fx+PF.fees.other+PF.fees.revolut;
const FEES_NET = FEES-PF.fees.promo;
const KOERS = TOT-DEPT-DIV_NET+FEES_NET;
const FWD = sum(POS.map(p=>p.fwd||0));
const UNREAL = sum(OPEN.map(p=>p.unreal)), REAL = sum(POS.map(p=>p.realized));
const NAMES = Object.fromEntries(POS.map(p=>[p.sym,p.name]));
// ---- boekhouding: stortingen en opnames uit de exports + eigen invoer (opgeslagen in je database)
const DEPROWS = PF.depositRows.map(r=>Object.assign({},r));
function allDeps(){ return DEPROWS; }
function parseAmount(v){ v=String(v||"").trim().replace(/[€\s]/g,""); if(!v) return null; if(v.includes(",")) v=v.replace(/\./g,"").replace(",","."); else if(/^\d{1,3}(\.\d{3})+$/.test(v)) v=v.replace(/\./g,""); const n=parseFloat(v); return isNaN(n)?null:n; }
const GOAL = PF.goals.minMonthly;
const mk = (y,m) => `${y}-${String(m).padStart(2,"0")}`;
const CUR_M = TODAY.getMonth()+1;
let MDEP={}, streak=0, STREAK_FROM="", AVG12=0;
function rebuildDeps(){
  MDEP={}; allDeps().forEach(x=>{ const k=x.d.slice(0,7); (MDEP[k]=MDEP[k]||{t:0,Degiro:0,Revolut:0,man:0}); MDEP[k].t+=x.a; MDEP[k][x.b]=(MDEP[k][x.b]||0)+x.a; if(x.src==="man") MDEP[k].man+=x.a; });
  streak=0; { let y=Y, m=CUR_M-1; if(m<1){m=12;y--;} while((MDEP[mk(y,m)]||{t:0}).t>=GOAL){ streak++; m--; if(m<1){m=12;y--;} } }
  { let y=Y, m=CUR_M-streak; while(m<1){m+=12;y--;} STREAK_FROM=`${MNF[m-1]} ${y}`; }
  { let t=0,y=Y,m=CUR_M-1; for(let k=0;k<12;k++){ if(m<1){m=12;y--;} t+=(MDEP[mk(y,m)]||{t:0}).t; m--; } AVG12=t/12; }
}
rebuildDeps();
// kleuren per positie (vaste volgorde op ticker, nooit op rang)
const SYMCOL = {}; [...POS].sort((a,b)=>a.first<b.first?-1:a.first>b.first?1:0).forEach((p,i)=>SYMCOL[p.sym]=`var(--c${(i%6)+1})`);
const symc = k => SYMCOL[k]||"var(--neutral)";

/* =====================================================================
   HERO
   ===================================================================== */
const HERO = { r:"ALL", dep:true, bm:true };
function rStart(r){
  if(r==="ALL") return 0;
  const d=new Date(TODAY);
  if(r==="1M") d.setMonth(d.getMonth()-1); else if(r==="3M") d.setMonth(d.getMonth()-3); else if(r==="1J") d.setFullYear(d.getFullYear()-1);
  else if(r==="YTD") return iOf(`${Y-1}-12-31`);
  return Math.max(0,Math.round((d-START)/DAY));
}
const R_LBL={ "1M":"afgelopen maand","3M":"afgelopen 3 maanden","YTD":"dit jaar","1J":"afgelopen jaar","ALL":"sinds je start" };
function setBig(el,v){ const whole=Math.floor(Math.abs(v)), c=Math.round((Math.abs(v)-whole)*100);
  el.replaceChildren(document.createTextNode((v<0?"−":"")+"€"+nf(whole,0))); const sp=h("span","cents",","+String(c===100?99:c).padStart(2,"0")); el.append(sp); }
function heroAt(i, animate){
  const i0=rStart(HERO.r);
  if(animate) countUp($("heroBig"),V[i],v=>{ setBig($("heroBig"),v); return $("heroBig").textContent; }); else setBig($("heroBig"),V[i]);
  $("heroWhen").textContent = i===LAST ? "· vandaag" : "· "+fD(i);
  const g=V[i]-DEP[i], gp=DEP[i]?g/DEP[i]*100:0;
  const pg=$("heroGain"); pg.className="pill "+dirc(g); pg.textContent=`${arrow(g)} ${seur(g)} (${spct(gp)})`;
  pg.title="Totale winst: waarde min alles wat je hebt ingelegd";
  const pr=$("heroPeriod"); pr.replaceChildren();
  if(HERO.r==="ALL"){ if(i===LAST) pr.append(h("span",null,`${pct(PF.stats.xirr)} per jaar`)); }
  else if(i>i0){ const pgain=(V[i]-V[i0])-(DEP[i]-DEP[i0]), tw=(IDX[i]/IDX[i0]-1)*100;
    const a=h("span",dirc(pgain),`${seur(pgain)} (${spct(tw)})`); a.style.fontWeight=600; pr.append(a, document.createTextNode(" "+(i===LAST?R_LBL[HERO.r]:"in deze periode"))); }
  pr.append(h("span","muted",` · ingelegd ${eur(DEP[i])}`));
}
function renderHero(){
  const host=$("heroChart"), W=host.clientWidth, H=host.clientHeight; if(!W) return;
  const i0=rStart(HERO.r), i1=LAST, m={t:26,r:58,b:28,l:0}, iw=W-m.l-m.r, ih=H-m.t-m.b;
  let vals=V.slice(i0,i1+1); if(HERO.dep) vals=vals.concat(DEP.slice(i0,i1+1)); if(HERO.bm) vals=vals.concat(BM.slice(i0,i1+1));
  const mx=Math.max(...vals), mn=Math.min(...vals);
  const sc = HERO.r==="ALL" ? ticks(0,mx*1.04,4) : ticks(mn-(mx-mn)*.12, mx+(mx-mn)*.08, 4);
  const X=i=>m.l+(i-i0)/Math.max(1,i1-i0)*iw, Yv=v=>m.t+ih-(v-sc.lo)/(sc.hi-sc.lo)*ih;
  const svg=s("svg",{width:W,height:H,viewBox:`0 0 ${W} ${H}`,role:"img","aria-label":"Verloop van je vermogen"});
  const defs=s("defs"); defs.innerHTML=`<linearGradient id="hg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".38"/><stop offset=".7" stop-color="var(--accent)" stop-opacity=".05"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient>`; svg.append(defs);
  sc.t.forEach(v=>{ if(v<sc.lo||v>sc.hi) return; svg.append(s("line",{x1:m.l+20,x2:W-m.r+8,y1:Yv(v),y2:Yv(v)},"stroke:var(--grid);stroke-width:1")); svg.append(st(W-m.r+14,Yv(v)+4,eurK(v),"start",AX)); });
  // maand-ticks
  const months=[]; { const d=dOf(i0); d.setDate(1); d.setMonth(d.getMonth()+1); while(d<=TODAY){ months.push(Math.round((d-START)/DAY)); d.setMonth(d.getMonth()+1); } }
  const per=iw/Math.max(1,months.length), stepM=Math.max(1,Math.ceil(64/per));
  months.forEach((mi,k)=>{ if(k%stepM) return; const d=dOf(mi); const lab=d.getMonth()===0?`jan '${String(d.getFullYear()).slice(2)}`:MN[d.getMonth()]; svg.append(st(X(mi),H-8,lab,"middle",AX)); });
  const path=arr=>{ let d=""; for(let i=i0;i<=i1;i++) d+=(i===i0?"M":"L")+X(i).toFixed(1)+","+Yv(arr[i]).toFixed(1); return d; };
  const lineV=path(V);
  svg.append(s("path",{d:lineV+`L${X(i1)},${m.t+ih}L${X(i0)},${m.t+ih}Z`,fill:"url(#hg)"}));
  if(HERO.dep) svg.append(s("path",{d:path(DEP),fill:"none"},"stroke:var(--ink-3);stroke-width:1.5;stroke-linejoin:round"));
  if(HERO.bm) svg.append(s("path",{d:path(BM),fill:"none"},"stroke:var(--ink-2);stroke-width:1.5;stroke-dasharray:4 4;opacity:.75"));
  svg.append(s("path",{d:lineV,fill:"none",class:"glow"},"stroke:var(--accent);stroke-width:2.2;stroke-linejoin:round;stroke-linecap:round"));
  const ex=X(i1), ey=Yv(V[i1]);
  svg.append(s("circle",{cx:ex,cy:ey,r:5,class:"pulse"},"fill:var(--accent)"));
  svg.append(s("circle",{cx:ex,cy:ey,r:4.5},"fill:var(--accent);stroke:var(--panel);stroke-width:2"));
  // scrub
  const cross=s("line",{y1:m.t-8,y2:m.t+ih},"stroke:var(--ink-3);stroke-width:1;visibility:hidden");
  const dV=s("circle",{r:5},"fill:var(--accent);stroke:var(--panel);stroke-width:2.5;visibility:hidden");
  const dD=s("circle",{r:3.5},"fill:var(--ink-3);stroke:var(--panel);stroke-width:2;visibility:hidden");
  const dB=s("circle",{r:3.5},"fill:var(--ink-2);stroke:var(--panel);stroke-width:2;visibility:hidden");
  svg.append(cross,dD,dB,dV);
  const ov=s("rect",{x:0,y:0,width:W-m.r,height:H,fill:"transparent"}); svg.append(ov);
  const lab=$("scrubDate");
  const move=e=>{ const r=svg.getBoundingClientRect(); let i=Math.round(i0+(e.clientX-r.left-m.l)/iw*(i1-i0)); i=Math.max(i0,Math.min(i1,i)); const x=X(i);
    cross.setAttribute("x1",x); cross.setAttribute("x2",x); cross.style.visibility="visible";
    dV.setAttribute("cx",x); dV.setAttribute("cy",Yv(V[i])); dV.style.visibility="visible";
    if(HERO.dep){ dD.setAttribute("cx",x); dD.setAttribute("cy",Yv(DEP[i])); dD.style.visibility="visible"; }
    if(HERO.bm){ dB.setAttribute("cx",x); dB.setAttribute("cy",Yv(BM[i])); dB.style.visibility="visible"; }
    lab.textContent=fD(i)+(HERO.bm?`  ·  S&P ${eur(BM[i])}`:""); lab.style.left=Math.max(70,Math.min(W-90,x))+"px"; lab.classList.add("on");
    heroAt(i,false); };
  const leave=()=>{ [cross,dV,dD,dB].forEach(c=>c.style.visibility="hidden"); lab.classList.remove("on"); heroAt(LAST,false); };
  ov.addEventListener("pointermove",move); ov.addEventListener("pointerdown",move); ov.addEventListener("pointerleave",leave); ov.addEventListener("pointerup",e=>{ if(e.pointerType!=="mouse") leave(); });
  [...host.querySelectorAll("svg")].forEach(x=>x.remove()); host.prepend(svg);
}
$("rangeSeg").addEventListener("click",e=>{ const b=e.target.closest("button"); if(!b) return; HERO.r=b.dataset.r; $("rangeSeg").querySelectorAll("button").forEach(x=>x.classList.toggle("on",x===b)); renderHero(); heroAt(LAST,false); });
document.querySelectorAll(".hero .chip[data-s]").forEach(c=>c.addEventListener("click",()=>{ const k=c.dataset.s; HERO[k]=!HERO[k]; c.classList.toggle("off",!HERO[k]); renderHero(); }));

/* =====================================================================
   KPI-STRIP
   ===================================================================== */
function stripCell(label,val,meta,cls){ const d=h("div"); d.append(h("div","eyebrow",label)); const v=h("div","v num"+(cls?" "+cls:""),val); d.append(v); const m=h("div","m"); if(meta instanceof Node) m.append(meta); else m.textContent=meta; d.append(m); return d; }
function renderStrip(){
  const st_=$("strip"); st_.replaceChildren();
  st_.append(stripCell("Ingelegd",eur(DEPT),PF.brokers.map(b=>`${b} ${eur(sum(PF.deposits.filter(x=>x[1]===b).map(x=>x[2])))}`).join(" · ")));
  st_.append(stripCell("Totale winst",seur(GAIN),`${spct(GAIN/DEPT*100)} op je inleg`,dirc(GAIN)));
  st_.append(stripCell("Rendement per jaar",pct(PF.stats.xirr),"geldgewogen, sinds start"));
  const ytdM=h("span"); ytdM.append(document.createTextNode("S&P 500: "), h("span",dirc(PF.stats.ytd_bm),spct(PF.stats.ytd_bm)));
  st_.append(stripCell(`Rendement ${Y}`,spct(PF.stats.ytd),ytdM,dirc(PF.stats.ytd)));
  st_.append(stripCell(`Dividend ${Y}`,eur(DIV_Y,2),`≈ ${eur(FWD)} komende 12 mnd`));
}

/* =====================================================================
   JIJ VS S&P
   ===================================================================== */
function renderVs(){
  const diff=TOT-BM[LAST];
  $("vsBig").textContent = `${seur(diff)} ${diff>=0?"voor":"achter"}`; $("vsBig").className="vs-big num "+dirc(diff);
  $("vsSince").textContent = "sinds "+fD(0);
  const behind = PF.stats.ytd < PF.stats.ytd_bm;
  const tag=$("vsTag"); tag.replaceChildren(h("span","tag "+(behind?"bad":"ok"),`${Y}: ${spct(PF.stats.ytd)} vs ${spct(PF.stats.ytd_bm)}`));
  $("vsTxt").textContent = `Had je elke storting op dezelfde dag in de S&P 500 gestoken, dan had je nu ${eur(BM[LAST])} gehad. ${behind?`Over de hele periode sta je voor, maar dit jaar loopt de S&P 500 duidelijk harder.`:`Je verslaat de index ook dit jaar.`}`;
  $("vsX1").textContent=pct(PF.stats.xirr); $("vsX2").textContent=pct(PF.stats.xirr_bm);
  const host=$("vsChart"), W=host.clientWidth, H=host.clientHeight; if(!W) return;
  const i0=DEP.findIndex(x=>x>0), m={t:10,r:50,b:22,l:0}, iw=W-m.l-m.r, ih=H-m.t-m.b;
  const D=V.map((v,i)=>v-BM[i]); const sl=D.slice(i0); const mx=Math.max(...sl,1), mn=Math.min(...sl,-1);
  const sc=ticks(mn*1.1,mx*1.1,3), X=i=>m.l+(i-i0)/(LAST-i0)*iw, Yv=v=>m.t+ih-(v-sc.lo)/(sc.hi-sc.lo)*ih, y0=Yv(0);
  const svg=s("svg",{width:W,height:H,viewBox:`0 0 ${W} ${H}`,role:"img","aria-label":"Verschil met S&P 500 door de tijd"});
  const cid="c"+Math.random().toString(36).slice(2,7);
  const defs=s("defs"); defs.innerHTML=`<clipPath id="${cid}a"><rect x="0" y="0" width="${W}" height="${y0}"/></clipPath><clipPath id="${cid}b"><rect x="0" y="${y0}" width="${W}" height="${H-y0}"/></clipPath>`; svg.append(defs);
  sc.t.forEach(v=>{ svg.append(s("line",{x1:m.l,x2:W-m.r+6,y1:Yv(v),y2:Yv(v)},`stroke:${v===0?"var(--line-3)":"var(--grid)"};stroke-width:1`)); svg.append(st(W-m.r+12,Yv(v)+4,(v>0?"+":"")+eurK(v).replace("€-","−€"),"start",AX)); });
  let line=""; for(let i=i0;i<=LAST;i++) line+=(i===i0?"M":"L")+X(i).toFixed(1)+","+Yv(D[i]).toFixed(1);
  const area=line+`L${X(LAST)},${y0}L${X(i0)},${y0}Z`;
  svg.append(s("path",{d:area,"clip-path":`url(#${cid}a)`},"fill:var(--up);opacity:.22"));
  svg.append(s("path",{d:area,"clip-path":`url(#${cid}b)`},"fill:var(--down);opacity:.22"));
  svg.append(s("path",{d:line,fill:"none"},"stroke:var(--ink-2);stroke-width:1.5"));
  [new Date(Y,0,1)].forEach(d=>{ const i=Math.round((d-START)/DAY); if(i>i0) { svg.append(s("line",{x1:X(i),x2:X(i),y1:m.t,y2:m.t+ih},"stroke:var(--line-2);stroke-dasharray:2 3")); svg.append(st(X(i)+5,m.t+9,String(Y),"start",AX)); } });
  const cross=s("line",{y1:m.t,y2:m.t+ih},"stroke:var(--ink-3);visibility:hidden"), dot=s("circle",{r:4},"fill:var(--ink);stroke:var(--panel);stroke-width:2;visibility:hidden");
  svg.append(cross,dot);
  const ov=s("rect",{x:0,y:0,width:W-m.r,height:H,fill:"transparent"}); svg.append(ov);
  ov.addEventListener("pointermove",e=>{ const r=svg.getBoundingClientRect(); let i=Math.round(i0+(e.clientX-r.left-m.l)/iw*(LAST-i0)); i=Math.max(i0,Math.min(LAST,i)); const x=X(i);
    cross.setAttribute("x1",x); cross.setAttribute("x2",x); cross.style.visibility="visible"; dot.setAttribute("cx",x); dot.setAttribute("cy",Yv(D[i])); dot.style.visibility="visible";
    tip(host,x,Yv(D[i]),fD(i),[{n:"Jij",c:"var(--accent)",v:eur(V[i])},{n:"S&P 500",c:"var(--ink-2)",dash:1,v:eur(BM[i])},{n:"Verschil",v:seur(D[i]),cls:dirc(D[i]),tot:1}]); });
  ov.addEventListener("pointerleave",()=>{ cross.style.visibility=dot.style.visibility="hidden"; untip(host); });
  [...host.querySelectorAll("svg")].forEach(x=>x.remove()); host.prepend(svg);
}

/* =====================================================================
   DOELEN (RINGEN)
   ===================================================================== */
function goals(){
  let hit=0, done=0; for(let m=1;m<CUR_M;m++){ done++; if((MDEP[mk(Y,m)]||{t:0}).t>=GOAL) hit++; }
  const g1=done?hit/done:0;
  const g2=Math.min(1,DIV_Y/PF.goals.etfPrice);
  const target=PF.stats.ytd_bm+PF.goals.margin; const g3=Math.max(0,Math.min(1,PF.stats.ytd/target));
  return [
    {c:"var(--c1)",p:g1,t:`Elke maand ≥ ${eur(GOAL)} inleggen`,d:`${hit} van ${done} maanden · reeks ${streak}`,s:hit/done>=.75?["ok","Op koers"]:["warn","Let op"]},
    {c:"var(--c2)",p:g2,t:`Dividend voor 1 ${PF.goals.etf} (${eur(PF.goals.etfPrice,2)})`,d:`${eur(DIV_Y,2)} binnen · nog ${eur(Math.max(0,PF.goals.etfPrice-DIV_Y),2)}`,s:g2>=1?["ok","Gehaald"]:g2>=.75?["warn","Bijna"]:["bad","Achter"]},
    {c:"var(--c3)",p:g3,t:`Rendement ≥ S&P 500 + ${nf(PF.goals.margin,0)}%`,d:`${spct(PF.stats.ytd)} vs doel ${spct(target)}`,s:PF.stats.ytd>=target?["ok","Gehaald"]:["bad","Achter"]},
  ];
}
function renderGoals(){
  $("goalYear").textContent=Y;
  const G=goals(), svg=$("rings"); svg.replaceChildren();
  G.forEach((g,k)=>{ const r=72-k*19, C=2*Math.PI*r;
    svg.append(s("circle",{cx:85,cy:85,r,fill:"none"},`stroke:${g.c};opacity:.16;stroke-width:13`));
    const a=s("circle",{cx:85,cy:85,r,fill:"none",transform:"rotate(-90 85 85)","stroke-dasharray":C,"stroke-dashoffset":C},`stroke:${g.c};stroke-width:13;stroke-linecap:round`);
    svg.append(a); requestAnimationFrame(()=>requestAnimationFrame(()=>a.setAttribute("stroke-dashoffset",C*(1-Math.max(.015,g.p))))); });
  const ul=$("goalList"); ul.replaceChildren();
  G.forEach(g=>{ const li=h("li"); const dot=h("span","dot"); dot.style.setProperty("--c",g.c); const d=h("div","d");
    d.append(h("span","tag "+g.s[0],(g.s[0]==="ok"?"✓ ":g.s[0]==="bad"?"✕ ":"! ")+g.s[1]), document.createTextNode(`${Math.round(g.p*100)}% · ${g.d}`));
    li.append(dot,h("div","t",g.t),d); ul.append(li); });
}

/* =====================================================================
   VERGELIJKING (waar komt je geld vandaan)
   ===================================================================== */
function renderEq(){
  const items=[["Ingelegd",DEPT,"var(--c1)",""],["Koerswinst",KOERS,"var(--up)","+"],["Dividend",DIV_NET,"var(--c3)","+"],["Kosten",-FEES_NET,"var(--down)","−"]];
  const eq=$("eq"); eq.replaceChildren();
  items.forEach(([l,v,c,op],k)=>{ const d=h("div"); if(k) d.append(h("span","op",op)); d.append(h("div","l",l)); const vv=h("div","v num",k?seur(v,0):eur(v)); if(k) vv.classList.add(dirc(v)); d.append(vv); eq.append(d); });
  $("eqTotal").textContent=eur(TOT);
  const p100=$("per100"); p100.replaceChildren(document.createTextNode("Elke "), h("b",null,"€100"), document.createTextNode(" die je inlegde, is nu "), h("b","up",eur(TOT/DEPT*100)), document.createTextNode(" waard."));
  const bar=$("compbar"); bar.replaceChildren(); const pos=DEPT+KOERS+DIV_NET;
  [[DEPT,"var(--c1)"],[KOERS,"var(--up)"],[DIV_NET,"var(--c3)"]].forEach(([v,c])=>{ const i=h("i"); i.style.width=(v/pos*100)+"%"; i.style.background=c; bar.append(i); });
  bar.setAttribute("aria-label",`Ingelegd ${pct(DEPT/pos*100,0)}, koerswinst ${pct(KOERS/pos*100,0)}, dividend ${pct(DIV_NET/pos*100,1)}`);
}

/* =====================================================================
   TEGELKAART
   ===================================================================== */
function squarify(items,x,y,w,hh){
  const total=sum(items.map(i=>i.value)); const out=[]; if(!total) return out;
  const sc=w*hh/total; let list=items.map(i=>Object.assign({},i,{area:i.value*sc}));
  let rx=x, ry=y, rw=w, rh=hh, row=[];
  const worst=(r,side)=>{ const ss=sum(r.map(i=>i.area)), mx=Math.max(...r.map(i=>i.area)), mn=Math.min(...r.map(i=>i.area)); return Math.max(side*side*mx/(ss*ss),(ss*ss)/(side*side*mn)); };
  const lay=r=>{ const ss=sum(r.map(i=>i.area));
    if(rw>=rh){ const cw=ss/rh; let cy=ry; r.forEach(i=>{ const ih=i.area/cw; out.push(Object.assign(i,{x:rx,y:cy,w:cw,h:ih})); cy+=ih; }); rx+=cw; rw-=cw; }
    else { const ch=ss/rw; let cx=rx; r.forEach(i=>{ const iw=i.area/ch; out.push(Object.assign(i,{x:cx,y:ry,w:iw,h:ch})); cx+=iw; }); ry+=ch; rh-=ch; } };
  let k=0; while(k<list.length){ const side=Math.min(rw,rh), it=list[k]; if(!row.length||worst(row.concat([it]),side)<=worst(row,side)){ row.push(it); k++; } else { lay(row); row=[]; } }
  if(row.length) lay(row); return out;
}
function tileBg(p){ const r=p.cost?p.unreal/p.cost*100:0; const t=Math.min(1,Math.abs(r)/(r>=0?60:25)); const c=r>=0?"var(--up)":"var(--down)"; return `color-mix(in oklab, ${c} ${Math.round(12+t*48)}%, var(--panel-2))`; }
function renderTreemap(id){
  const host=$(id), W=host.clientWidth, H=host.clientHeight; if(!W) return; host.replaceChildren();
  squarify(OPEN.map(p=>({p,value:p.value})),0,0,W,H).forEach(r=>{ const p=r.p, g=2;
    const t=h("button","tile"+(r.w<92||r.h<64?" sm":"")+(r.w<54||r.h<44?" xs":""));
    Object.assign(t.style,{left:r.x+g+"px",top:r.y+g+"px",width:Math.max(0,r.w-2*g)+"px",height:Math.max(0,r.h-2*g)+"px",background:tileBg(p)});
    const rp=p.cost?p.unreal/p.cost*100:0;
    const top=h("div"); top.append(h("div","tk",p.sym),h("div","nm",p.name));
    const bt=h("div","bt"); bt.append(h("b",dirc(rp),`${arrow(rp)} ${spct(rp)}`),h("span","val",eur(p.value)));
    t.append(top,bt); t.setAttribute("aria-label",`${p.name}: ${eur(p.value)}, ${spct(rp)}`);
    t.addEventListener("click",()=>openDrawer(p.sym)); host.append(t); });
}

/* =====================================================================
   SPREIDING
   ===================================================================== */
const LENS={
  soort:{sub:"ETF's tegenover losse aandelen",key:p=>p.type==="ETF"?"ETF":"Aandelen",fixed:["ETF","Aandelen"]},
  sector:{sub:"Per sector, met ETF's als eigen groep",key:p=>p.sector||"Overig"},
  valuta:{sub:"In welke valuta je posities noteren",key:p=>p.cur||"EUR",fixed:["EUR","USD"]},
  broker:{sub:"Waar je beleggingen staan",key:null,fixed:[]},
};
function brokerSplit(){ const q={}; PF.trades.forEach(([d,b,sym,qty])=>{ const k=b+"|"+sym; q[k]=(q[k]||0)+qty; }); const out={}; PF.brokers.forEach(b=>out[b]=0);
  OPEN.forEach(p=>{ PF.brokers.forEach(b=>{ const qq=q[b+"|"+p.sym]||0; if(qq>1e-9) out[b]+=p.value*qq/p.qty; }); }); if(PF.brokers.length) out[PF.brokers[0]]+=CASH; return out; }
let LENS_ON="soort";
function renderAlloc(){
  const L=LENS[LENS_ON]; $("allocSub").textContent=L.sub;
  let g={}; if(L.key){ OPEN.forEach(p=>{ const k=L.key(p); g[k]=(g[k]||0)+p.value; }); } else g=brokerSplit();
  let keys=Object.keys(g).filter(k=>g[k]>0.005);
  if(keys.length>6){ const sorted=[...keys].sort((a,b)=>g[b]-g[a]); sorted.slice(5).forEach(k=>{ if(k==="Overig") return; g.Overig=(g.Overig||0)+g[k]; delete g[k]; }); keys=Object.keys(g).filter(k=>g[k]>0.005); }
  const fixed=L.fixed||[], order=fixed.concat(keys.filter(k=>!fixed.includes(k)).sort());
  const colOf=k=>k==="Overig"?"var(--neutral)":`var(--c${(order.indexOf(k)%6)+1})`;
  if(L.key&&CASH>1){ g.Cash=CASH; keys.push("Cash"); }
  const tot=sum(keys.map(k=>g[k])); keys.sort((a,b)=>(a==="Cash")-(b==="Cash")||g[b]-g[a]);
  const bar=$("abar"), ul=$("alist"); bar.replaceChildren(); ul.replaceChildren();
  keys.forEach(k=>{ const c=k==="Cash"?"var(--neutral)":colOf(k); const b=h("i"); b.style.width=(g[k]/tot*100)+"%"; b.style.background=c; b.title=`${k} ${pct(g[k]/tot*100)}`; bar.append(b);
    const li=h("li"), sw=h("i","key sq"); sw.style.setProperty("--c",c); li.append(sw,h("span",null,k),h("span","p num",pct(g[k]/tot*100,0)),h("span","a num",eur(g[k]))); ul.append(li); });
  bar.setAttribute("aria-label",keys.map(k=>`${k} ${pct(g[k]/tot*100,0)}`).join(", "));
}
$("allocSeg").addEventListener("click",e=>{ const b=e.target.closest("button"); if(!b) return; LENS_ON=b.dataset.l; $("allocSeg").querySelectorAll("button").forEach(x=>x.classList.toggle("on",x===b)); renderAlloc(); });

/* =====================================================================
   INLEG-HEATMAP
   ===================================================================== */
function renderHeat(){
  const hm=$("heatmap"); hm.replaceChildren();
  const years=[...new Set(Object.keys(MDEP).map(k=>+k.slice(0,4)))].sort(); if(!years.includes(Y)) years.push(Y);
  const max=Math.max(...Object.values(MDEP).map(x=>x.t));
  hm.append(h("div")); MN.forEach(m=>hm.append(h("div","ml",m))); hm.append(h("div","ml th","totaal"));
  years.forEach(y=>{ hm.append(h("div","yl",String(y)));
    for(let m=1;m<=12;m++){ const k=mk(y,m), x=MDEP[k], future=(y>Y)||(y===Y&&m>CUR_M), now=y===Y&&m===CUR_M, before=dOf(0)>new Date(y,m,0);
      const c=h("div","cell"+((before||future)?" none":"")+(now&&!x?" now":""));
      if(x&&x.t>0){ const a=.18+.82*Math.sqrt(x.t/max); c.style.background=`color-mix(in oklab, var(--accent) ${Math.round(a*100)}%, var(--panel-2))`; c.style.borderColor="transparent"; c.textContent=eurK(x.t).replace("€",""); if(x.t>=GOAL) c.append(h("span","ck up","✓")); }
      else if(!before&&!future&&!now){ c.textContent="0"; c.append(h("span","ck down","✕")); }
      else if(now) c.textContent="…";
      c.title=`${MNF[m-1]} ${y}: ${x?`${eur(x.t,2)} (${PF.brokers.map(b=>`${b} ${eur(x[b]||0,2)}`).join(", ")})`:future?"nog niet":"geen inleg"}`;
      hm.append(c); }
    const yt=sum(Object.entries(MDEP).filter(([k])=>k.startsWith(y)).map(([,v])=>v.t)); hm.append(h("div","tot num",eur(yt))); });
  $("hmSub").textContent=`Kleur = hoeveel je die maand inlegde · doel ${eur(GOAL)}`;
  const f=$("hmFoot"); f.replaceChildren();
  const add=(l,v)=>{ const sp=h("span"); sp.append(document.createTextNode(l+" "),h("b",null,v)); f.append(sp); };
  add("Reeks:",`${streak} maanden op rij`); add("Gemiddeld:",`${eur(AVG12)} p/m (12 mnd)`); add("Hoogste:",eur(max));
}

/* =====================================================================
   INZICHTEN & ACTIVITEIT
   ===================================================================== */
const INS_ICO={
  up:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--up-ink)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16l6-6 4 4 6-7"/><path d="M15 7h5v5"/></svg>',
  down:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--down-ink)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8l6 6 4-4 6 7"/><path d="M15 17h5v-5"/></svg>',
  pie:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-ink)" stroke-width="2.2" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/></svg>',
  scale:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-ink)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v16M5 20h14M6 8h12M6 8l-3 6a3 3 0 0 0 6 0zM18 8l-3 6a3 3 0 0 0 6 0z"/></svg>',
  flame:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--warn-ink)" stroke-width="2.2" stroke-linejoin="round"><path d="M12 21c4 0 7-2.7 7-6.5 0-3.2-2.2-5-3.5-7.5-.6 1.8-1.8 3-3 3 .3-3-1-5.6-3.5-7 .2 3-2.2 5-3.4 7A7 7 0 0 0 5 14.5C5 18.3 8 21 12 21z"/></svg>',
  fee:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-2)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/></svg>'};
function renderInsights(){
  const ul=$("insights"); ul.replaceChildren();
  const best=[...OPEN].sort((a,b)=>b.unreal/b.cost-a.unreal/a.cost)[0], worst=[...OPEN].sort((a,b)=>a.unreal/a.cost-b.unreal/b.cost)[0];
  const big=OPEN[0], etf=sum(OPEN.filter(p=>p.type==="ETF").map(p=>p.value));
  const top3=sum(OPEN.slice(0,3).map(p=>p.value))/INV*100;
  const L=[
    ["up",["",best.name," is je sterkste belegging: ",`${spct(best.unreal/best.cost*100,0)} sinds aankoop`,` (${seur(best.unreal)}).`]],
    ["down",["",worst.name," doet het het minst: ",spct(worst.unreal/worst.cost*100,0),` (${seur(worst.unreal)}).`]],
    ["pie",["Je grootste positie is ",big.name," met ",pct(big.value/INV*100,0),` van je portfolio. Je top 3 is samen `,pct(top3,0),"."]],
    ["scale",["",pct(etf/INV*100,0)," zit in brede ETF's, ",pct(100-etf/INV*100,0)," in losse aandelen."]],
    ["flame",["Je legt ",`${streak} maanden op rij`," minstens "+eur(GOAL)+" in, gemiddeld ",eur(AVG12)," per maand het afgelopen jaar."]],
    ["fee",["Je betaalde ",`${eur(FEES,0)} aan kosten`,` over ${PF.fees.orders} orders: gemiddeld `,`${eur(FEES/PF.fees.orders,2)} per order`,"."]],
  ];
  L.forEach(([ic,parts])=>{ const li=h("li"); const ics=h("span","ic"); ics.innerHTML=INS_ICO[ic]; li.append(ics); const p=h("span"); parts.forEach((t,k)=>p.append(k%2?h("b",null,t):document.createTextNode(t))); li.append(p); ul.append(li); });
}
const ICO={dep:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  buy:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  sell:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
  div:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="6"/></svg>'};
function events(){
  const ev=[];
  PF.deposits.forEach(([d,b,a])=>ev.push({d,k:a>=0?"dep":"sell",t:a>=0?`Storting naar ${b}`:`Opname bij ${b}`,s:fDs(d),a:seur(a,2),cls:""}));
  PF.trades.forEach(([d,b,sym,q,pr,cur,tot])=>ev.push({d,k:q>0?"buy":"sell",t:`${q>0?"Gekocht":"Verkocht"} ${nf(Math.abs(q),Math.abs(q)%1?2:0)}× ${NAMES[sym]||sym}`,s:`${fDs(d)} · ${b}`,a:eur(Math.abs(tot),2),cls:""}));
  const g={}; DIVS.forEach(x=>{ const k=x.d+x.sym; (g[k]=g[k]||{d:x.d,sym:x.sym,n:0}).n+=x.n; });
  Object.values(g).forEach(x=>{ if(Math.abs(x.n)>.005) ev.push({d:x.d,k:"div",t:`Dividend ${NAMES[x.sym]||x.sym}`,s:fDs(x.d)+" · netto",a:seur(x.n,2),cls:"up"}); });
  return ev.sort((a,b)=>b.d.localeCompare(a.d));
}
function renderFeed(){ const ul=$("feed"); ul.replaceChildren();
  events().slice(0,7).forEach(e=>{ const li=h("li"), ic=h("span","ic "+e.k); ic.innerHTML=ICO[e.k]; const mid=h("div"); mid.append(h("div","t",e.t),h("div","s",e.s)); li.append(ic,mid,h("div","a num "+e.cls,e.a)); ul.append(li); }); }

/* =====================================================================
   BOEKHOUDING
   ===================================================================== */
const BROKERS=PF.brokers.map((b,i)=>[b,`var(--c${(i%6)+1})`]);
const bcol=b=>(BROKERS.find(x=>x[0]===b)||[0,"var(--neutral)"])[1];
let BK_YEAR=Y, BK_F="all";
function renderBoek(){
  const D=allDeps(), tot=sum(D.map(x=>x.a));
  $("bkTitle").textContent=`${eur(tot,2)} ingelegd`;
  const yNow=sum(D.filter(x=>x.d.startsWith(Y)).map(x=>x.a));
  const sameNow=sum(D.filter(x=>x.d.startsWith(Y)&&+x.d.slice(5,7)<CUR_M).map(x=>x.a)), samePrev=sum(D.filter(x=>x.d.startsWith(Y-1)&&+x.d.slice(5,7)<CUR_M).map(x=>x.a));
  const mNow=(MDEP[mk(Y,CUR_M)]||{t:0}).t, prog=sameNow+Math.max(mNow,AVG12)+AVG12*(12-CUR_M);
  const st_=$("bkStrip"); st_.replaceChildren();
  const yy=h("span"); if(samePrev>0&&CUR_M>1){ const d=(sameNow/samePrev-1)*100; yy.append(h("span",dirc(d),spct(d,0)),document.createTextNode(` vs jan–${MN[CUR_M-2]} ${Y-1}`)); } else yy.textContent="alle rekeningen samen";
  st_.append(stripCell(`Dit jaar (${Y})`,eur(yNow,2),yy));
  const mm=h("span",mNow>=GOAL?"up":null,mNow>=GOAL?"✓ doel gehaald":`nog ${eur(GOAL-mNow)} tot je doel`);
  st_.append(stripCell(`Deze maand (${MN[CUR_M-1]})`,eur(mNow,2),mm));
  st_.append(stripCell("Gemiddeld per maand",eur(AVG12),"afgelopen 12 maanden"));
  st_.append(stripCell(`Verwacht eind ${Y}`,eurR(prog),"als je in dit tempo doorgaat"));
  st_.append(stripCell("Stortingen",String(D.filter(x=>x.a>0).length),`gemiddeld ${eur(tot/Math.max(1,D.filter(x=>x.a>0).length))} per keer`));
  const bar=$("bkAccBar"), box=$("bkAcc"); bar.replaceChildren(); box.replaceChildren();
  BROKERS.forEach(([b,c])=>{ const L=D.filter(x=>x.b===b); const t=sum(L.map(x=>x.a)); if(!L.length) return;
    const i=h("i"); i.style.width=(Math.max(0,t)/Math.max(1,tot)*100)+"%"; i.style.background=c; bar.append(i);
    const r=h("div","acc-card"), lg=h("span","logo",b.slice(0,3).toUpperCase()); lg.style.setProperty("--c",c);
    const mid=h("div"); mid.append(h("div","n",b),h("div","s",`${L.length} regels · sinds ${fDs(L[0].d)} ${L[0].d.slice(0,4)}`));
    const v=h("div","v num",eur(t)); v.append(h("small",null,`${pct(t/Math.max(1,tot)*100,0)} · gem. ${eur(t/L.length)}`)); r.append(lg,mid,v); box.append(r); });
  bar.setAttribute("aria-label",BROKERS.map(([b])=>`${b} ${pct(sum(D.filter(x=>x.b===b).map(x=>x.a))/Math.max(1,tot)*100,0)}`).join(", "));
  const years=[...new Set(D.map(x=>+x.d.slice(0,4)))].sort(); if(!years.includes(Y)) years.push(Y); if(!years.includes(BK_YEAR)) BK_YEAR=years[years.length-1];
  const seg=$("bkYearSeg"); seg.replaceChildren(); years.forEach(y=>{ const b=h("button",y===BK_YEAR?"on":null,String(y)); b.onclick=()=>{ BK_YEAR=y; renderBoek(); }; seg.append(b); });
  const t=$("bkYear"); t.replaceChildren(); const th=h("thead"), hr=h("tr"); ["Maand",...BROKERS.map(b=>b[0]),"Totaal","Opgeteld",""].forEach(x=>hr.append(h("th",null,x))); th.append(hr); t.append(th);
  const tb=h("tbody"); let cum=0, cnt=0, ytot=0, hits=0; const ymax=Math.max(1,...Array.from({length:12},(_,k)=>(MDEP[mk(BK_YEAR,k+1)]||{t:0}).t));
  for(let m=1;m<=12;m++){ const x=MDEP[mk(BK_YEAR,m)], fut=BK_YEAR>Y||(BK_YEAR===Y&&m>CUR_M), before=dOf(0)>new Date(BK_YEAR,m,0), cur=BK_YEAR===Y&&m===CUR_M;
    const r=h("tr",(fut||before)?"fut":null); r.append(h("td",null,MNF[m-1]+(cur?" (lopend)":"")));
    if(fut||before){ BROKERS.forEach(()=>r.append(h("td",null,"—"))); r.append(h("td",null,"—"),h("td",null,"—"),h("td",null,"")); tb.append(r); continue; }
    const tt=x?x.t:0; cum+=tt; ytot+=tt; if(!cur||tt>=GOAL){ cnt++; if(tt>=GOAL) hits++; }
    BROKERS.forEach(([b])=>r.append(h("td",null,x&&x[b]?eur(x[b],2):"—")));
    const tc=h("td"); const bb=h("span","bar"); bb.style.width=Math.max(0,Math.round(tt/ymax*60))+"px"; tc.append(bb,h("b",null,eur(tt,2))); r.append(tc);
    r.append(h("td","muted",eur(cum))); r.append(h("td",tt>=GOAL?"up":cur?"muted":"down",tt>=GOAL?"✓":cur?"…":"✕")); tb.append(r); }
  t.append(tb); const tf=h("tfoot"), fr=h("tr"); fr.append(h("td",null,"Totaal"));
  BROKERS.forEach(([b])=>fr.append(h("td",null,eur(sum(D.filter(x=>x.d.startsWith(BK_YEAR)&&x.b===b).map(x=>x.a)),2))));
  fr.append(h("td",null,eur(ytot,2)),h("td",null,""),h("td","up",`${hits}/${cnt}`)); tf.append(fr); t.append(tf);
  $("bkYearSub").textContent=`Gemiddeld ${eur(ytot/Math.max(1,cnt))} per maand · ${hits} van ${cnt} maanden boven je doel van ${eur(GOAL)}`;
  renderLedger(); renderBkChart();
}
function renderLedger(){
  const D=allDeps().filter(x=>BK_F==="all"||(BK_F==="man"?x.src==="man":x.b===BK_F)).reverse();
  $("bkLedgerSub").textContent=`${D.length} regels · ${eur(sum(D.map(x=>x.a)),2)}`;
  const box=$("bkLedger"); box.replaceChildren(); let cur="";
  if(!D.length){ box.append(h("p","muted","Nog niets hier.")); return; }
  D.forEach(x=>{ const k=x.d.slice(0,7);
    if(k!==cur){ cur=k; const hd=h("div","lg-m"); const [yy,mm]=k.split("-"); hd.append(h("span",null,`${MNF[+mm-1]} ${yy}`),h("span",null,eur(sum(D.filter(z=>z.d.startsWith(k)).map(z=>z.a)),2))); box.append(hd); }
    const r=h("div","lg-r"); const ac=h("span","acc"); const ai=h("i"); ai.style.setProperty("--c",bcol(x.b)); ac.append(ai,document.createTextNode(x.b));
    const inp=h("input"); inp.placeholder="Notitie toevoegen…"; inp.setAttribute("aria-label",`Notitie bij storting van ${fDs(x.d)}`);
    inp.value = x.note||"";
    inp.addEventListener("change",()=>{ const v=inp.value.trim().slice(0,120); CTX.saveNote(x.id,v).then(()=>{ x.note=v; CTX.toast("Notitie opgeslagen",1500); }).catch(e=>CTX.toast("Notitie opslaan mislukt: "+(e.message||e),4000)); });
    const del=h("button","del",x.src==="man"?"×":""); if(x.src==="man"){ del.setAttribute("aria-label","Verwijder"); del.onclick=()=>{ if(!confirm("Deze handmatige storting verwijderen?")) return; CTX.deleteManual(x.id); }; } else del.disabled=true;
    r.append(h("span","dt",fDs(x.d)),ac,inp,h("span","src"+(x.src==="man"?" man":""),x.src==="man"?"handmatig":"export"),h("span","amt",eur(x.a,2)),del); box.append(r); });
}
function renderBkChart(){
  const host=$("bkChart"), W=host.clientWidth, H=host.clientHeight; if(!W) return;
  const D=allDeps(), m={t:12,r:58,b:28,l:0}, iw=W-m.l-m.r, ih=H-m.t-m.b, n=LAST+1;
  const C=BROKERS.map(()=>new Array(n).fill(0));
  D.forEach(x=>{ const bi=BROKERS.findIndex(b=>b[0]===x.b); if(bi<0) return; C[bi][Math.max(0,Math.min(LAST,iOf(x.d)))]+=x.a; });
  C.forEach(a=>{ for(let i=1;i<n;i++) a[i]+=a[i-1]; });
  const lo=(bi,i)=>{ let v=0; for(let k=0;k<bi;k++) v+=C[k][i]; return v; }, hi=(bi,i)=>lo(bi,i)+C[bi][i], tot=i=>lo(C.length,i);
  let top=1; for(let i=0;i<n;i++) top=Math.max(top,tot(i));
  const sc=ticks(0,top*1.06,4), X=i=>m.l+i/Math.max(1,LAST)*iw, Yv=v=>m.t+ih-v/sc.hi*ih;
  const svg=s("svg",{width:W,height:H,viewBox:`0 0 ${W} ${H}`,role:"img","aria-label":"Ingelegd geld door de tijd"});
  sc.t.forEach(v=>{ svg.append(s("line",{x1:0,x2:W-m.r+6,y1:Yv(v),y2:Yv(v)},`stroke:${v?"var(--grid)":"var(--line-3)"}`)); svg.append(st(W-m.r+12,Yv(v)+4,eurK(v),"start",AX)); });
  const step=(L,Hh)=>{ let d=`M${X(0)},${Yv(Hh(0))}`; for(let i=1;i<n;i++){ if(Hh(i)!==Hh(i-1)) d+=`H${X(i)}V${Yv(Hh(i))}`; } d+=`H${X(LAST)}`; let b=`V${Yv(L(LAST))}`; for(let i=LAST;i>0;i--){ if(L(i)!==L(i-1)) b+=`H${X(i)}V${Yv(L(i-1))}`; } return d+b+`H${X(0)}Z`; };
  BROKERS.forEach(([b,c],bi)=>svg.append(s("path",{d:step(i=>lo(bi,i),i=>hi(bi,i))},`fill:${c};opacity:.9`)));
  const months=[]; { const d=dOf(0); d.setDate(1); d.setMonth(d.getMonth()+1); while(d<=TODAY){ months.push(Math.round((d-START)/DAY)); d.setMonth(d.getMonth()+1); } }
  const stepM=Math.max(1,Math.ceil(64/(iw/Math.max(1,months.length))));
  months.forEach((mi,k)=>{ if(k%stepM) return; const d=dOf(mi); svg.append(st(X(mi),H-8,d.getMonth()===0?`jan '${String(d.getFullYear()).slice(2)}`:MN[d.getMonth()],"middle",AX)); });
  const cross=s("line",{y1:m.t,y2:m.t+ih},"stroke:var(--ink);opacity:.4;visibility:hidden"); svg.append(cross);
  const ov=s("rect",{x:0,y:0,width:W-m.r,height:H,fill:"transparent"}); svg.append(ov);
  ov.addEventListener("pointermove",e=>{ const r=svg.getBoundingClientRect(); let i=Math.round((e.clientX-r.left-m.l)/iw*LAST); i=Math.max(0,Math.min(LAST,i)); const x=X(i); cross.setAttribute("x1",x); cross.setAttribute("x2",x); cross.style.visibility="visible";
    tip(host,x,Yv(tot(i)),fD(i),BROKERS.map(([b,c],bi)=>({n:b,c,sq:1,v:eur(C[bi][i],2)})).concat([{n:"Totaal ingelegd",v:eur(tot(i),2),tot:1}])); });
  ov.addEventListener("pointerleave",()=>{ cross.style.visibility="hidden"; untip(host); });
  [...host.querySelectorAll("svg")].forEach(x=>x.remove()); host.prepend(svg);
}
$("bkFilter").addEventListener("click",e=>{ const b=e.target.closest("button"); if(!b) return; BK_F=b.dataset.f; $("bkFilter").querySelectorAll("button").forEach(x=>x.classList.toggle("on",x===b)); renderLedger(); });
$("bkAddBtn").addEventListener("click",()=>{ const f=$("bkForm"); f.hidden=false; $("bkD").value=new Date().toISOString().slice(0,10); $("bkLedgerPanel").scrollIntoView({behavior:"smooth",block:"start"}); setTimeout(()=>$("bkA").focus(),350); });
$("bkForm").addEventListener("submit",e=>{ e.preventDefault(); const a=parseAmount($("bkA").value), d=$("bkD").value, err=$("bkErr");
  if(!d||a==null||a===0){ err.textContent="Vul een datum en een bedrag in (met een minteken voor een opname)."; err.hidden=false; return; } err.hidden=true;
  $("bkForm").querySelector("button[type=submit]").disabled=true;
  CTX.addManual({d,b:$("bkB").value,a:Math.round(a*100)/100,note:$("bkN").value.trim().slice(0,120)}); });

/* =====================================================================
   RAPPORT
   ===================================================================== */
const VAKKEN=[["disc","Discipline",.35,"Heb je je maanddoel ingelegd?","Precies je doel = 7,5 · 2× je doel = 10 · daaronder naar verhouding."],
  ["rend","Rendement",.35,"Deed je portfolio het beter dan de S&P 500?","Gelijk aan de S&P 500 = 6,5 · elk procentpunt verschil telt ±0,9."],
  ["kost","Kosten",.15,"Hoeveel ging er op aan kosten?","Geen kosten = 10 · elke 1% kosten op je orders kost 2 punten."],
  ["div","Dividend",.15,"Lig je op schema voor je ETF-doel?","Precies op schema = 8 · daarboven tot 10 · daaronder naar verhouding."]];
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)), r1=v=>Math.round(v*10)/10;
const gWord=g=>g>=9.5?"Uitstekend":g>=8.5?"Zeer goed":g>=7.5?"Goed":g>=6.5?"Ruim voldoende":g>=5.5?"Voldoende":g>=4.5?"Onvoldoende":"Ruim onvoldoende";
const gCls=g=>g>=7?"ok":g>=5.5?"mid":"bad";
const fg=g=>g==null?"—":nf(g,1);
function mEnd(y,m){ return Math.min(LAST,Math.round((new Date(y,m,0,12)-START)/DAY)); }
const MONTHS=[]; { const d=new Date(dOf(0)); d.setDate(1); while(d<=TODAY){ MONTHS.push([d.getFullYear(),d.getMonth()+1]); d.setMonth(d.getMonth()+1); } }
function monthReport(y,m){
  const key=mk(y,m), i1=mEnd(y,m), i0=Math.max(0,m===1?mEnd(y-1,12):mEnd(y,m-1)), partial=(y===Y&&m===CUR_M);
  const dep=(MDEP[key]||{t:0}).t, r=dep/GOAL; const g={};
  g.disc = (partial&&dep<GOAL) ? null : (r>=1?Math.min(10,7.5+(r-1)*2.5):1+6.5*r);
  let rp=null, rs=null; const v0=V[i0];
  if(v0>=500&&i1>i0){ rp=(IDX[i1]/IDX[i0]-1)*100; rs=(BMI[i1]/BMI[i0]-1)*100; g.rend=clamp(6.5+.9*(rp-rs),1,10); } else g.rend=null;
  const tr=PF.trades.filter(t=>t[0].startsWith(key)), vol=sum(tr.map(t=>Math.abs(t[6]))), fees=sum(tr.map(t=>t[7]))+sum((PF.feesOther||[]).filter(f=>f[0].startsWith(key)).map(f=>f[1]));
  let fp=null; if(vol>0){ fp=fees/vol*100; g.kost=clamp(10-2*fp,1,10); } else g.kost = fees>0?6:null;
  let dy=null, need=null; if(y>=PF.goals.divFrom){ dy=sum(DIVS.filter(x=>x.d.startsWith(String(y))&&x.d.slice(0,7)<=key).map(x=>x.n)); need=PF.goals.etfPrice*m/12; g.div=clamp(dy/need>=1?8+(dy/need-1)*8:1+7*(dy/need),1,10); } else g.div=null;
  let ws=0, gs=0; VAKKEN.forEach(([k,,w])=>{ if(g[k]!=null){ ws+=w; gs+=w*g[k]; } });
  for(const k in g) if(g[k]!=null) g[k]=r1(g[k]);
  return {y,m,key,partial,dep,r,rp,rs,fees,vol,fp,dy,need,v0,g,tot:ws?r1(gs/ws):null};
}
let REPORTS=[], RP_SEL=0;
function buildReports(){ REPORTS=MONTHS.map(([y,m])=>monthReport(y,m)); }
buildReports(); RP_SEL=Math.max(0,REPORTS.length-2);
function fact(R,k){
  if(k==="disc") return R.partial&&R.dep<GOAL?`Deze maand nog bezig: ${eur(R.dep)} van ${eur(GOAL)}.`:R.r>=1?`Je legde ${eur(R.dep)} in, ${nf(R.r,1)}× je doel.`:`Je legde ${eur(R.dep)} in, ${eur(GOAL-R.dep)} onder je doel.`;
  if(k==="rend") return R.rp==null?"Niet beoordeeld: te weinig vermogen aan het begin van de maand voor een eerlijk cijfer.":`Jij ${spct(R.rp)}, de S&P 500 ${spct(R.rs)}: ${R.rp>=R.rs?"je versloeg de index":"de index deed het beter"}.`;
  if(k==="kost") return R.vol>0?`${eur(R.fees,2)} kosten op ${eur(R.vol)} aan orders (${pct(R.fp,2)}).`:R.fees>0?`${eur(R.fees,2)} vaste kosten, geen orders.`:"Geen orders, dus geen kosten.";
  if(k==="div") return R.dy==null?`Je dividenddoel geldt vanaf ${PF.goals.divFrom}.`:`${eur(R.dy,2)} dividend binnen dit jaar; op schema was ${eur(R.need,2)}.`;
}
function renderBanner(){
  const R=REPORTS[REPORTS.length-2]||REPORTS[REPORTS.length-1]; const b=$("rapBanner"); b.replaceChildren();
  const gr=h("div","grade g-"+gCls(R.tot)); gr.style.setProperty("--p",R.tot*10); gr.append(h("span",null,fg(R.tot)));
  const mid=h("div"); mid.append(h("div","t",`Rapport ${MNF[R.m-1]}: ${gWord(R.tot).toLowerCase()}`),h("div","s","Je maandcijfer voor discipline, rendement, kosten en dividend · bekijk je rapport →"));
  const vk=h("div","vk"); VAKKEN.forEach(([k,n])=>{ const c=h("span","vk-chip"); c.append(document.createTextNode(n),h("b",R.g[k]==null?"muted":"gt-"+gCls(R.g[k]),fg(R.g[k]))); vk.append(c); });
  b.append(gr,mid,vk);
}
function renderRapport(){
  const R=REPORTS[RP_SEL]; if(!R) return;
  $("rpMonth").textContent=`${MNF[R.m-1]} ${R.y}`; $("rpPrev").disabled=RP_SEL===0; $("rpNext").disabled=RP_SEL===REPORTS.length-1;
  const gr=$("rpGrade"); gr.className="grade lg g-"+gCls(R.tot); gr.style.setProperty("--p",R.tot*10); gr.firstChild.textContent=fg(R.tot);
  $("rpWhen").textContent=R.partial?"Voorlopig · deze maand loopt nog":`Eindcijfer ${MNF[R.m-1]} ${R.y}`;
  $("rpLbl").textContent=gWord(R.tot);
  const prev=REPORTS[RP_SEL-1]; $("rpSub").textContent=prev?`Vorige maand: ${fg(prev.tot)} (${R.tot>=prev.tot?"+":"−"}${nf(Math.abs(R.tot-prev.tot),1)})`:"Je eerste maand";
  const av=VAKKEN.filter(([k])=>R.g[k]!=null).map(([k,n])=>[k,n,R.g[k]]).sort((a,b)=>b[2]-a[2]);
  const note=$("rpNote"); note.replaceChildren(h("span","h","Opmerking"));
  if(av.length){ const best=av[0], worst=av[av.length-1];
    note.append(document.createTextNode("Sterkste vak: "),h("b",null,`${best[1]} (${fg(best[2])})`),document.createTextNode(". "+fact(R,best[0])+" "));
    if(worst[2]<best[2]) note.append(document.createTextNode("Aandachtspunt: "),h("b",null,`${worst[1]} (${fg(worst[2])})`),document.createTextNode(". "+fact(R,worst[0])));
  }
  const vb=$("rpVakken"); vb.replaceChildren();
  VAKKEN.forEach(([k,n,w,q,how])=>{ const g=R.g[k]; const c=h("div","panel s3 vak"); const top=h("div","top"); top.append(h("h3",null,n),h("span","wt",`weegt ${Math.round(w*100)}%`)); top.firstChild.style.cssText="margin:0;font-size:14.5px;font-weight:580";
    const gg=h("div","g num "+(g==null?"muted":"gt-"+gCls(g)),fg(g)); const vbar=h("div","vbar g-"+(g==null?"bad":gCls(g))), vi=h("i"); vi.style.width=(g||0)*10+"%"; vbar.append(vi);
    c.append(top,h("div","muted",q),gg,vbar,h("p","f",fact(R,k)),h("div","how",how)); c.querySelector(".muted").style.fontSize="12.5px"; c.querySelector(".f").style.margin="12px 0 0"; vb.append(c); });
  // rapportkaart
  const t=$("rpCard"); t.replaceChildren(); const th=h("thead"), hr=h("tr"); hr.append(h("th",null,""));
  REPORTS.forEach((x,k)=>{ const c=h("th",k===RP_SEL?"sel":null); c.append(document.createTextNode(MN[x.m-1]),h("i",null,"'"+String(x.y).slice(2))); c.onclick=()=>{ RP_SEL=k; renderRapport(); }; hr.append(c); }); th.append(hr); t.append(th);
  const tb=h("tbody");
  VAKKEN.concat([["tot","Eindcijfer"]]).forEach(([k,n])=>{ const r=h("tr",k==="tot"?"tot":null); r.append(h("td",null,n));
    REPORTS.forEach((x,i)=>{ const g=k==="tot"?x.tot:x.g[k]; const c=h("td",(g==null?"na":g<5.5?"bad":g>=7.5?"ok":"")+(i===RP_SEL?" sel":""),fg(g)); c.onclick=()=>{ RP_SEL=i; renderRapport(); }; c.title=`${n} · ${MNF[x.m-1]} ${x.y}`; r.append(c); }); tb.append(r); });
  t.append(tb);
  const yr=REPORTS.filter(x=>x.y===R.y&&!x.partial); $("rpTrendSub").textContent=`Gemiddeld in ${R.y}: ${fg(r1(sum(yr.map(x=>x.tot))/Math.max(1,yr.length)))} · ${yr.filter(x=>x.tot>=5.5).length} van ${yr.length} maanden voldoende`;
  renderTrend();
}
function renderTrend(){
  const host=$("rpTrend"), W=host.clientWidth, H=host.clientHeight; if(!W) return;
  const m={t:14,r:16,b:28,l:30}, iw=W-m.l-m.r, ih=H-m.t-m.b, n=REPORTS.length, X=k=>m.l+(n<2?iw/2:k/(n-1)*iw), Yv=g=>m.t+ih-(g-1)/9*ih;
  const svg=s("svg",{width:W,height:H,viewBox:`0 0 ${W} ${H}`,role:"img","aria-label":"Eindcijfer per maand"});
  [1,4,5.5,7,10].forEach(g=>{ svg.append(s("line",{x1:m.l,x2:W-m.r,y1:Yv(g),y2:Yv(g)},g===5.5?"stroke:var(--down);stroke-dasharray:4 4;opacity:.6":"stroke:var(--grid)")); svg.append(st(m.l-8,Yv(g)+4,nf(g,g%1?1:0),"end",AX)); });
  svg.append(st(W-m.r,Yv(5.5)-6,"voldoende","end","fill:var(--down-ink);font:11px var(--mono);opacity:.8"));
  let d=""; REPORTS.forEach((x,k)=>d+=(k?"L":"M")+X(k).toFixed(1)+","+Yv(x.tot).toFixed(1)); svg.append(s("path",{d,fill:"none",class:"glow"},"stroke:var(--accent);stroke-width:2;stroke-linejoin:round"));
  REPORTS.forEach((x,k)=>{ const c=s("circle",{cx:X(k),cy:Yv(x.tot),r:k===RP_SEL?6:4.5},`fill:var(--${x.tot>=7?"up":x.tot>=5.5?"warn":"down"});stroke:var(--panel);stroke-width:2;cursor:pointer${x.partial?";opacity:.5":""}`);
    c.addEventListener("click",()=>{ RP_SEL=k; renderRapport(); }); c.addEventListener("pointerenter",()=>tip(host,X(k),Yv(x.tot),`${MNF[x.m-1]} ${x.y}${x.partial?" · voorlopig":""}`,[{n:"Eindcijfer",v:fg(x.tot)},...VAKKEN.map(([kk,nn])=>({n:nn,v:fg(x.g[kk])}))])); c.addEventListener("pointerleave",()=>untip(host)); svg.append(c);
    if(k%(iw/n<34?2:1)===0) svg.append(st(X(k),H-8,MN[x.m-1],"middle",AX)); });
  [...host.querySelectorAll("svg")].forEach(x=>x.remove()); host.prepend(svg);
}
$("rpPrev").addEventListener("click",()=>{ if(RP_SEL>0){ RP_SEL--; renderRapport(); } });
$("rpNext").addEventListener("click",()=>{ if(RP_SEL<REPORTS.length-1){ RP_SEL++; renderRapport(); } });

/* =====================================================================
   POSITIES
   ===================================================================== */
const SORT={k:"value",dir:-1};
function spark(sym,w=86,hh=26){ const P=PF.px[sym]; if(!P) return h("span"); const a=P.eur.slice(-90); const mn=Math.min(...a), mx=Math.max(...a);
  const sv=s("svg",{width:w,height:hh,viewBox:`0 0 ${w} ${hh}`}); let d=""; a.forEach((v,i)=>{ d+=(i?"L":"M")+(i/(a.length-1)*(w-4)+2).toFixed(1)+","+(hh-3-(v-mn)/((mx-mn)||1)*(hh-6)).toFixed(1); });
  const upish=a[a.length-1]>=a[0]; sv.append(s("path",{d,fill:"none"},"stroke:var(--ink-3);stroke-width:1.4;stroke-linejoin:round"));
  sv.append(s("circle",{cx:w-2,cy:hh-3-(a[a.length-1]-mn)/((mx-mn)||1)*(hh-6),r:2.6},`fill:var(--${upish?"up":"down"})`)); return sv; }
function renderPositions(){
  $("posTitle").textContent=`${OPEN.length} posities, ${eur(INV)}`;
  $("posLead").textContent=`Verdeeld over ${PF.brokers.join(" en ")}. Koersen van ${PF.priceAsof?fDs(PF.priceAsof)+" "+PF.priceAsof.slice(0,4):"—"}, omgerekend naar euro's.`;
  const ps=$("posStrip"); ps.replaceChildren();
  ps.append(stripCell("Waarde posities",eur(INV),`plus ${eur(CASH,2)} cash`));
  ps.append(stripCell("Ongerealiseerd",seur(UNREAL),"winst op wat je nu hebt",dirc(UNREAL)));
  ps.append(stripCell("Gerealiseerd",seur(REAL),"winst op wat je verkocht",dirc(REAL)));
  ps.append(stripCell("Dividend ontvangen",eur(DIV_NET,2),"netto, sinds start"));
  const cols=[["name","Positie"],["qty","Aantal"],["avg","Gem. aankoop"],["price","Koers"],["value","Waarde"],["w","Gewicht"],["unreal","Winst"],["ret","Rendement"],["spark","90 dagen"]];
  const rows=OPEN.map(p=>Object.assign({},p,{avg:p.cost/p.qty,priceE:p.value/p.qty,w:p.value/INV,ret:p.unreal/p.cost}));
  rows.sort((a,b)=>{ const k=SORT.k==="price"?"priceE":SORT.k; const x=a[k],y=b[k]; return (typeof x==="string"?x.localeCompare(y):x-y)*SORT.dir; });
  const t=$("posTable"); t.replaceChildren(); const th=h("thead"), tr=h("tr");
  cols.forEach(([k,l])=>{ const c=h("th",SORT.k===k?"on":null,l+(SORT.k===k?(SORT.dir<0?" ↓":" ↑"):"")); if(k!=="spark") c.onclick=()=>{ SORT.dir=SORT.k===k?-SORT.dir:-1; SORT.k=k; renderPositions(); }; tr.append(c); });
  th.append(tr); t.append(th); const tb=h("tbody");
  rows.forEach(p=>{ const r=h("tr"); r.onclick=()=>openDrawer(p.sym);
    const who=h("div","who"), lg=h("span","logo",p.sym.slice(0,4)); lg.style.setProperty("--c",symc(p.sym)); const nm=h("div"); nm.append(h("div","n",p.name),h("div","b",`${p.sym} · ${p.broker.replace("+"," + ")}`)); who.append(lg,nm);
    const c0=h("td"); c0.append(who); r.append(c0);
    r.append(h("td",null,nf(p.qty,p.qty%1?3:0)), h("td",null,eur(p.avg,2)), h("td",null,eur(p.priceE,2)), h("td",null,eur(p.value)));
    const wt=h("td"); wt.append(document.createTextNode(pct(p.w*100,0))); const wb=h("span","wbar"), wi=h("i"); wi.style.width=(p.w/OPEN[0].value*INV*100)+"%"; wb.append(wi); wt.append(wb); r.append(wt);
    r.append(h("td",dirc(p.unreal),seur(p.unreal)), h("td",dirc(p.ret),spct(p.ret*100)));
    const sp=h("td"); sp.append(spark(p.sym)); r.append(sp); tb.append(r); });
  t.append(tb);
  // trackrecord
  const R=POS.filter(p=>Math.abs(p.realized)>.01).sort((a,b)=>b.realized-a.realized); const mx=Math.max(...R.map(p=>Math.abs(p.realized)));
  const wins=R.filter(p=>p.realized>0).length; $("trSub").textContent=`${wins} van ${R.length} met winst · samen ${seur(REAL)}`;
  const box=$("trackrecord"); box.replaceChildren();
  R.forEach(p=>{ const row=h("div","tr-row"); row.append(h("span",null,p.name)); const b=h("div","tr-bar"), i=h("i"); const w=Math.abs(p.realized)/mx*50;
    i.style.width=w+"%"; i.style.left=p.realized>=0?"50%":(50-w)+"%"; i.style.background=p.realized>=0?"var(--up)":"var(--down)"; b.append(i); row.append(b, h("b","num "+dirc(p.realized),seur(p.realized))); row.lastChild.style.textAlign="right"; box.append(row); });
  // kosten
  $("costBig").textContent=eur(FEES,2);
  $("costTxt").textContent=`${pct(FEES/DEPT*100,1)} van alles wat je inlegde. Gemiddeld ${eur(FEES/PF.fees.orders,2)} per order, ${PF.fees.orders} orders in totaal.${PF.fees.promo>0?` Je kreeg ${eur(PF.fees.promo,2)} promotiekorting terug.`:""}`;
  const C=[["Transactiekosten",PF.fees.trans,"var(--c1)"],["Valutakosten (AutoFX)",PF.fees.fx,"var(--c2)"],["Aansluitingskosten beurzen",PF.fees.other,"var(--c3)"],["Revolut",PF.fees.revolut,"var(--c4)"]];
  const cb=$("costBar"), cl=$("costList"); cb.replaceChildren(); cl.replaceChildren();
  C.forEach(([l,v,c])=>{ const i=h("i"); i.style.width=(v/FEES*100)+"%"; i.style.background=c; cb.append(i); const li=h("li"), sw=h("i","key sq"); sw.style.setProperty("--c",c); li.append(sw,h("span",null,l),h("span","p num",pct(v/FEES*100,0)),h("span","a num",eur(v,2))); cl.append(li); });
}

/* ---------- drawer ---------- */
function openDrawer(sym){
  const p=POS.find(x=>x.sym===sym); if(!p) return; const dr=$("drawer"); dr.replaceChildren();
  const head=h("div"); head.style.cssText="display:flex;align-items:center;gap:12px";
  const lg=h("span","logo",sym.slice(0,4)); lg.style.setProperty("--c",symc(sym)); const nm=h("div"); nm.style.flex="1"; nm.append(h("div","n",p.name),h("div","b muted",`${sym} · ${p.broker.replace("+"," + ")} · ${p.type}`)); nm.firstChild.style.fontWeight="600";
  const x=h("button","ibtn","✕"); x.setAttribute("aria-label","Sluiten"); x.onclick=closeDrawer; head.append(lg,nm,x); dr.append(head);
  const big=h("div","big num"); big.style.fontSize="52px"; big.style.margin="22px 0 10px"; setBig(big,p.value); dr.append(big);
  const rp=p.unreal/p.cost*100; const d=h("div","hero-delta"); d.append(h("span","pill "+dirc(p.unreal),`${arrow(p.unreal)} ${seur(p.unreal)} (${spct(rp)})`),h("span","muted","sinds je eerste aankoop")); dr.append(d);
  const ch=h("div","chart"); ch.style.height="230px"; ch.style.marginTop="18px"; dr.append(ch);
  const g=h("div","dgrid"); const mini=(l,v,c)=>{ const m=h("div","mini"); m.append(h("div","l",l),h("div","v num"+(c?" "+c:""),v)); g.append(m); };
  mini("Aantal",nf(p.qty,p.qty%1?4:0)); mini("Gem. aankoopprijs",eur(p.cost/p.qty,2)); mini("Huidige koers",eur(p.value/p.qty,2)); mini("Ingelegd (incl. kosten)",eur(p.cost,2));
  mini("Dividend ontvangen",eur(p.div,2)); mini("Gerealiseerd",seur(p.realized,2),Math.abs(p.realized)>.01?dirc(p.realized):"");
  dr.append(g); dr.append(h("div","eyebrow","Transacties"));
  const ul=h("ul","dlist"); PF.trades.filter(t=>t[2]===sym).reverse().forEach(([dd,b,s_,q,pr,cur,tot,fee])=>{ const li=h("li"); li.append(h("span",null,`${fDs(dd)} ${dd.slice(0,4)} · ${q>0?"Koop":"Verkoop"} ${nf(Math.abs(q),Math.abs(q)%1?4:0)} @ ${cur==="USD"?"$":"€"}${nf(pr,2)}`),h("span","num",`${eur(Math.abs(tot),2)}`)); ul.append(li); });
  dr.append(ul);
  $("scrim").classList.add("on"); dr.classList.add("on"); dr.setAttribute("aria-hidden","false");
  requestAnimationFrame(()=>drawerChart(ch,p));
}
function drawerChart(host,p){
  const P=PF.px[p.sym]; if(!P) return; const W=host.clientWidth, H=host.clientHeight, m={t:12,r:52,b:24,l:0}, iw=W-m.l-m.r, ih=H-m.t-m.b;
  const a=P.eur, s0=iOf(P.start); const avg=p.cost/p.qty; const sc=ticks(Math.min(...a,avg)*.95,Math.max(...a,avg)*1.04,4);
  const X=k=>m.l+k/(a.length-1)*iw, Yv=v=>m.t+ih-(v-sc.lo)/(sc.hi-sc.lo)*ih;
  const svg=s("svg",{width:W,height:H,viewBox:`0 0 ${W} ${H}`});
  sc.t.forEach(v=>{ if(v<sc.lo||v>sc.hi) return; svg.append(s("line",{x1:0,x2:W-m.r+6,y1:Yv(v),y2:Yv(v)},"stroke:var(--grid)")); svg.append(st(W-m.r+12,Yv(v)+4,"€"+nf(v,v<100?1:0),"start",AX)); });
  let d=""; a.forEach((v,k)=>d+=(k?"L":"M")+X(k).toFixed(1)+","+Yv(v).toFixed(1));
  svg.append(s("path",{d:d+`L${X(a.length-1)},${m.t+ih}L0,${m.t+ih}Z`},"fill:var(--accent);opacity:.08"));
  svg.append(s("line",{x1:0,x2:W-m.r,y1:Yv(avg),y2:Yv(avg)},"stroke:var(--warn);stroke-dasharray:4 4;stroke-width:1.2"));
  svg.append(st(W-m.r-4,Yv(avg)+(Yv(avg)>m.t+ih-20?-6:15),"gem. aankoop "+eur(avg,2),"end","fill:var(--warn-ink);font:11px var(--mono);paint-order:stroke;stroke:var(--panel);stroke-width:4px"));
  svg.append(s("path",{d,fill:"none",class:"glow"},"stroke:var(--accent);stroke-width:2"));
  PF.trades.filter(t=>t[2]===p.sym).forEach(([dd,b,s_,q])=>{ const k=iOf(dd)-s0; if(k<0||k>=a.length) return; const x=X(k), y=Yv(a[k]);
    const tri=q>0?`M${x},${y+5}l-5,9h10z`:`M${x},${y-5}l-5,-9h10z`; svg.append(s("path",{d:tri},`fill:var(--${q>0?"up":"down"});stroke:var(--panel);stroke-width:1.5`)); });
  const dd0=new Date(P.start+"T12:00:00"); svg.append(st(0,H-6,`${MN[dd0.getMonth()]} ${dd0.getFullYear()}`,"start",AX)); svg.append(st(W-m.r,H-6,"nu","end",AX));
  host.replaceChildren(svg);
  const lg=h("div","chips"); lg.style.marginTop="10px"; [["▲ aankoop","up"],["▼ verkoop","down"]].forEach(([t,c])=>lg.append(h("span","chip "+c,t))); host.after(lg);
}
function closeDrawer(){ $("scrim").classList.remove("on"); $("drawer").classList.remove("on"); $("drawer").setAttribute("aria-hidden","true"); }
$("scrim").addEventListener("click",closeDrawer); document.addEventListener("keydown",e=>{ if(e.key==="Escape") closeDrawer(); });

/* =====================================================================
   DIVIDEND
   ===================================================================== */
function renderDividend(){
  $("divTitle").textContent=`${eur(DIV_NET,2)} netto ontvangen`;
  $("divLead").textContent=`Sinds je start, van ${new Set(DIVS.filter(x=>x.g>0).map(x=>x.sym)).size} verschillende posities. Met wat je nu hebt verwacht je ongeveer ${eur(FWD,2)} in de komende 12 maanden.`;
  const ds=$("divStrip"); ds.replaceChildren();
  ds.append(stripCell(`Dit jaar (${Y})`,eur(DIV_Y,2),`${DIVS.filter(x=>x.d.startsWith(Y)&&x.g>0).length} uitkeringen`));
  ds.append(stripCell("Verwacht komende 12 mnd",eur(FWD,2),"op basis van je huidige posities"));
  ds.append(stripCell("Dividendrendement",pct(FWD/INV*100,2),"verwacht dividend ÷ waarde"));
  ds.append(stripCell("Ingehouden belasting",eur(DIV_TAX,2),"dividendbelasting, sinds start"));
  // maandgrafiek
  const host=$("divChart"), W=host.clientWidth, H=host.clientHeight;
  if(W){ const months=[]; { const d=new Date(dOf(0)); d.setDate(1); while(d<=TODAY){ months.push(mk(d.getFullYear(),d.getMonth()+1)); d.setMonth(d.getMonth()+1); } }
    const agg=months.map(k=>{ const L=DIVS.filter(x=>x.d.startsWith(k)); return {k,n:sum(L.map(x=>x.n)),t:-sum(L.map(x=>x.t)),L}; });
    const m={t:14,r:8,b:38,l:44}, iw=W-m.l-m.r, ih=H-m.t-m.b; const sc=ticks(0,Math.max(...agg.map(a=>a.n+a.t))*1.15,4);
    const Yv=v=>m.t+ih-v/sc.hi*ih, band=iw/agg.length, bw=Math.min(22,band*.6);
    const svg=s("svg",{width:W,height:H,viewBox:`0 0 ${W} ${H}`,role:"img","aria-label":"Dividend per maand"});
    sc.t.forEach(v=>{ svg.append(s("line",{x1:m.l,x2:W-m.r,y1:Yv(v),y2:Yv(v)},`stroke:${v?"var(--grid)":"var(--line-3)"}`)); svg.append(st(m.l-8,Yv(v)+4,"€"+nf(v,0),"end",AX)); });
    agg.forEach((a,k)=>{ const x=m.l+band*k+(band-bw)/2; const [yy,mm]=a.k.split("-");
      if(a.n>0){ const hN=a.n/sc.hi*ih, hT=a.t/sc.hi*ih; svg.append(s("rect",{x,y:Yv(a.n),width:bw,height:hN,rx:2},"fill:var(--up)"));
        if(hT>2.5){ const yT=Yv(a.n)-hT; svg.append(s("path",{d:`M${x},${yT+hT-2}V${yT+Math.min(4,hT-2)}a4,4 0 0 1 4,-4h${bw-8}a4,4 0 0 1 4,4V${yT+hT-2}Z`},"fill:var(--neutral)")); } }
      if(k%(band<26?2:1)===0) svg.append(st(x+bw/2,H-20,MN[+mm-1],"middle",AX));
      if(+mm===1||k===0) svg.append(st(x+bw/2,H-4,yy,"middle",AX+";fill:var(--ink-2)"));
      const hit=s("rect",{x:m.l+band*k,y:m.t,width:band,height:ih,fill:"transparent"});
      hit.addEventListener("pointerenter",()=>{ const by={}; a.L.forEach(x=>by[x.sym]=(by[x.sym]||0)+x.n); const rows=Object.entries(by).filter(([,v])=>Math.abs(v)>.005).sort((p,q)=>q[1]-p[1]).map(([k2,v])=>({n:NAMES[k2]||k2,v:eur(v,2)}));
        rows.push({n:"Totaal netto",v:eur(a.n,2),tot:1}); if(a.t>0) rows.push({n:"Belasting",v:eur(a.t,2)}); tip(host,m.l+band*(k+.5),Yv(a.n+a.t),`${MNF[+mm-1]} ${yy}`,rows.length>1?rows:[{n:"Geen dividend",v:"—"}]); });
      hit.addEventListener("pointerleave",()=>untip(host)); svg.append(hit); });
    [...host.querySelectorAll("svg")].forEach(x=>x.remove()); host.prepend(svg); }
  // ETF-doel
  const pr=PF.goals.etfPrice, p=Math.min(1,DIV_Y/pr);
  $("etfH").textContent=`Doel: 1 hele ${PF.goals.etf}`;
  $("etfSub").textContent=`${PF.goals.etfName} · koers ${eur(pr,2)}`;
  $("etfBig").textContent=`${Math.round(p*100)}%`; $("etfTxt").textContent= p>=1?`Gehaald! Je hebt dit jaar genoeg dividend voor een hele ${PF.goals.etf}.`:`Nog ${eur(pr-DIV_Y,2)} dividend nodig vóór 31 december. Verwacht in de rest van ${Y}: ongeveer ${eur(restYearFwd(),2)}.`;
  $("etfTag").replaceChildren(h("span","tag "+(p>=1?"ok":p>=.75?"warn":"bad"),p>=1?"✓ Gehaald":p>=.75?"! Bijna":"Achter"));
  requestAnimationFrame(()=>{ $("etfMeter").style.transition="width 1.2s cubic-bezier(.2,.8,.2,1)"; $("etfMeter").style.width=(p*100)+"%"; });
  const ef=$("etfFoot"); ef.replaceChildren(); [["Binnen",eur(DIV_Y,2)],["Doel",eur(pr,2)]].forEach(([l,v])=>{ const sp=h("span"); sp.append(document.createTextNode(l+" "),h("b",null,v)); ef.append(sp); });
  // kalender
  const cal=$("divCal"); cal.replaceChildren(); const ms=[]; { const d=new Date(TODAY); d.setDate(1); d.setMonth(d.getMonth()-11); for(let k=0;k<12;k++){ ms.push(mk(d.getFullYear(),d.getMonth()+1)); d.setMonth(d.getMonth()+1); } }
  cal.style.gridTemplateColumns=`minmax(140px,1.4fr) repeat(12,minmax(34px,1fr)) 80px`; cal.style.minWidth="640px";
  cal.append(h("div")); ms.forEach(k=>cal.append(h("div","ml",MN[+k.slice(5)-1]))); cal.append(h("div","ml","12 mnd"));
  const syms=OPEN.map(p=>p.sym).filter(sy=>DIVS.some(x=>x.sym===sy&&ms.includes(x.d.slice(0,7))&&x.g>0));
  const mxv=Math.max(...syms.flatMap(sy=>ms.map(k=>sum(DIVS.filter(x=>x.sym===sy&&x.d.startsWith(k)).map(x=>x.n)))));
  syms.forEach(sy=>{ cal.append(h("div","pl",NAMES[sy])); let tt=0;
    ms.forEach(k=>{ const v=sum(DIVS.filter(x=>x.sym===sy&&x.d.startsWith(k)).map(x=>x.n)); tt+=v; const c=h("div","c"); if(v>.005){ const i=h("i"); const sz=8+Math.sqrt(v/mxv)*16; i.style.width=i.style.height=sz+"px"; c.append(i); c.title=`${NAMES[sy]} · ${MNF[+k.slice(5)-1]}: ${eur(v,2)}`; } cal.append(c); });
    const tv=h("div","num",eur(tt,2)); tv.style.textAlign="right"; tv.style.fontSize="13px"; cal.append(tv); });
}
function qtyAt(sym,iso){ return sum(PF.trades.filter(t=>t[2]===sym&&t[0]<iso).map(t=>t[3])); }
function restYearFwd(){ // verwacht rest van dit jaar: uitkeringen uit dezelfde maanden vorig jaar, per aandeel × huidig aantal
  let t=0; OPEN.forEach(p=>{ DIVS.filter(x=>x.sym===p.sym&&x.d.startsWith(Y-1)&&+x.d.slice(5,7)>CUR_M).forEach(x=>{ const q=qtyAt(p.sym,x.d); if(q>0) t+=x.n/q*p.qty; }); }); return t; }

/* =====================================================================
   TOEKOMST
   ===================================================================== */
const FUT={m:Math.round(AVG12/10)*10,r:PF.forecast.rate,y:Y+20,real:false};
function futModel(o){ const months=(o.y-Y)*12+(12-CUR_M)+1, rm=Math.pow(1+o.r/100,1/12)-1; let v=TOT,c=TOT; const P=[{k:0,v,c}];
  for(let k=1;k<=months;k++){ v=v*(1+rm)+o.m; c+=o.m; const df=o.real?Math.pow(1+PF.forecast.inflation/100,k/12):1; P.push({k,v:v/df,c:c/df}); } return P; }
function renderFuture(){
  $("fM").value=FUT.m; $("fR").value=FUT.r; $("fY").value=FUT.y; $("fReal").checked=FUT.real;
  $("fMv").textContent=eur(FUT.m); $("fRv").textContent=pct(FUT.r,1); $("fYv").textContent=FUT.y;
  $("fRealLbl").textContent=`In euro's van nu (${nf(PF.forecast.inflation,1)}% inflatie)`;
  $("fMh").textContent=`Je gemiddelde afgelopen 12 maanden: ${eur(AVG12)}`; $("fYh").textContent=`Over ${FUT.y-Y} jaar`;
  $("futLead").textContent=`Vanaf je vermogen van vandaag (${eur(TOT)}), met echte cijfers als startpunt.`;
  const P=futModel(FUT), E=P[P.length-1];
  $("fLbl").textContent=`Verwacht vermogen eind ${FUT.y}${FUT.real?" · in euro's van nu":""}`; $("fBig").textContent=eurR(E.v);
  $("fIncome").textContent=`≈ ${eurR(E.v*.04/12)} per maand uit te keren met de 4%-regel`;
  $("fS").textContent=eur(TOT); $("fD").textContent=eurR(E.c-TOT); $("fG").textContent="+"+eurR(E.v-E.c); $("fCT").textContent=`Groei tot en met ${FUT.y}`;
  const host=$("futChart"), W=host.clientWidth, H=host.clientHeight;
  if(W){ const m={t:24,r:56,b:26,l:0}, iw=W-m.l-m.r, ih=H-m.t-m.b, sc=ticks(0,E.v*1.06,4), X=k=>m.l+k/(P.length-1)*iw, Yv=v=>m.t+ih-v/sc.hi*ih;
    const svg=s("svg",{width:W,height:H,viewBox:`0 0 ${W} ${H}`}); const defs=s("defs"); defs.innerHTML=`<linearGradient id="fg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".32"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient>`; svg.append(defs);
    sc.t.forEach(v=>{ svg.append(s("line",{x1:0,x2:W-m.r+6,y1:Yv(v),y2:Yv(v)},"stroke:var(--grid)")); svg.append(st(W-m.r+12,Yv(v)+4,eurK(v),"start",AX)); });
    for(let yy=Math.ceil((Y+1)/5)*5; yy<=FUT.y; yy+=(FUT.y-Y>30?10:5)){ const k=(yy-Y)*12+(12-CUR_M)-11; if(k>0) svg.append(st(X(k),H-8,String(yy),"middle",AX)); }
    let dv="",dc=""; P.forEach((p,k)=>{ dv+=(k?"L":"M")+X(k).toFixed(1)+","+Yv(p.v).toFixed(1); dc+=(k?"L":"M")+X(k).toFixed(1)+","+Yv(p.c).toFixed(1); });
    svg.append(s("path",{d:dv+`L${X(P.length-1)},${Yv(0)}L0,${Yv(0)}Z`,fill:"url(#fg)"})); svg.append(s("path",{d:dc,fill:"none"},"stroke:var(--ink-3);stroke-width:1.5"));
    svg.append(s("path",{d:dv,fill:"none",class:"glow"},"stroke:var(--accent);stroke-width:2.2"));
    [10000,25000,50000,100000,250000,500000,1000000].filter(L=>L>TOT).forEach(L=>{ const k=P.findIndex(p=>p.v>=L); if(k<1) return; const x=X(k), y=Yv(L);
      svg.append(s("circle",{cx:x,cy:y,r:4.5},"fill:var(--panel);stroke:var(--accent);stroke-width:2"));
      const yr=Y+Math.floor((CUR_M-1+k)/12); svg.append(st(x+(x>W-120?-8:8),y-10,`${eurK(L)} · ${yr}`,x>W-120?"end":"start","fill:var(--ink);font:600 11.5px var(--font);paint-order:stroke;stroke:var(--panel);stroke-width:4px"));
    });
    const cross=s("line",{y1:m.t,y2:m.t+ih},"stroke:var(--ink-3);visibility:hidden"); svg.append(cross);
    const ov=s("rect",{x:0,y:0,width:W-m.r,height:H,fill:"transparent"}); svg.append(ov);
    ov.addEventListener("pointermove",e=>{ const r=svg.getBoundingClientRect(); let k=Math.round((e.clientX-r.left)/iw*(P.length-1)); k=Math.max(0,Math.min(P.length-1,k)); const x=X(k); cross.setAttribute("x1",x); cross.setAttribute("x2",x); cross.style.visibility="visible";
      const yr=Y+Math.floor((CUR_M-1+k)/12), mo=(CUR_M-1+k)%12; tip(host,x,Yv(P[k].v),`${MN[mo]} ${yr}`,[{n:"Verwacht vermogen",c:"var(--accent)",v:eurR(P[k].v)},{n:"Startpunt + inleg",c:"var(--ink-3)",v:eurR(P[k].c)},{n:"Groei",v:"+"+eurR(P[k].v-P[k].c),cls:"up",tot:1}]); });
    ov.addEventListener("pointerleave",()=>{ cross.style.visibility="hidden"; untip(host); });
    [...host.querySelectorAll("svg")].forEach(x=>x.remove()); host.prepend(svg); }
  const W2=$("whatif"); W2.replaceChildren();
  [[`${eur(50)} per maand meer`,{m:FUT.m+50}],[`${eur(100)} per maand meer`,{m:FUT.m+100}],["1% meer rendement",{r:FUT.r+1}],["5 jaar langer doorgaan",{y:FUT.y+5}],[`${eur(100)} per maand minder`,{m:Math.max(0,FUT.m-100)}]].forEach(([t,ch])=>{
    const A=futModel(Object.assign({},FUT,ch)); const dlt=A[A.length-1].v-E.v; const li=h("li"); li.append(h("span",null,t),h("b",dirc(dlt),(dlt>=0?"+":"−")+eurR(Math.abs(dlt)).replace("−",""))); W2.append(li); });
}
[["fM","m"],["fR","r"],["fY","y"]].forEach(([id,k])=>$(id).addEventListener("input",e=>{ FUT[k]=+e.target.value; renderFuture(); }));
$("fReal").addEventListener("change",e=>{ FUT.real=e.target.checked; renderFuture(); });

/* =====================================================================
   DATA
   ===================================================================== */
function renderData(){
  const bs=brokerSplit(), ul=$("recon"); ul.replaceChildren();
  PF.brokers.forEach((b,k)=>{ const li=h("li"), sw=h("i","key sq"); sw.style.setProperty("--c",`var(--c${(k%6)+1})`); li.append(sw,h("span",null,`${b} (posities + cash)`),h("span","p",""),h("span","a num",eur(bs[b]||0,2))); ul.append(li); });
  { const li=h("li"), sw=h("i","key sq"); sw.style.setProperty("--c","var(--ink)"); li.append(sw,h("span",null,"Totaal"),h("span","p",""),h("span","a num",eur(TOT,2))); ul.append(li); }
  const S=CTX.settings()||{}, g=PF.goals;
  $("sMin").value=nf(g.minMonthly,0); $("sMargin").value=nf(g.margin,1); $("sDivFrom").value=g.divFrom; $("sRate").value=nf(PF.forecast.rate,1); $("sInfl").value=nf(PF.forecast.inflation,1);
  const sel=$("sEtf"); sel.replaceChildren(); OPEN.forEach(p=>{ const o=h("option",null,`${p.name} (${p.sym})`); o.value=p.key; if(p.key===g.etfKey) o.selected=true; sel.append(o); });
  $("setForm").onsubmit=e=>{ e.preventDefault(); const num=id=>parseAmount($(id).value);
    const next=Object.assign({},S,{goals:{minMonthly:num("sMin")??g.minMonthly,etfKey:sel.value||null,margin:num("sMargin")??g.margin,divFrom:Math.round(num("sDivFrom")||g.divFrom)},forecast:{rate:num("sRate")??PF.forecast.rate,inflation:num("sInfl")??PF.forecast.inflation}});
    CTX.saveSettings(next); };
  $("pxSub").textContent=PF.priceAsof?`Laatste koers: ${fDs(PF.priceAsof)} ${PF.priceAsof.slice(0,4)} · bron: Yahoo Finance`:"Nog geen koersen";
  $("pxWarn").textContent=CTX.priceErr()||(PF.missing.length?`Geen koers voor: ${PF.missing.join(", ")}. Daar rekenen we met de laatste aankoopkoers; vul hieronder een koerssymbool in.`:"Worden automatisch bijgewerkt als je het dashboard opent (hooguit elke 6 uur).");
  $("pxBtn").onclick=()=>CTX.refreshNow();
  const SECT=[...new Set(["Wereldwijde ETF","S&P 500-ETF","Dividend-ETF","Nasdaq-ETF","Technologie","Communicatie","Consument","Financieel","Gezondheidszorg","Industrie","Energie","Vastgoed","Overig"].concat(PF.instruments.map(i=>i.sector).filter(Boolean)))];
  $("secList").replaceChildren(...SECT.map(x=>{ const o=document.createElement("option"); o.value=x; return o; }));
  const t=$("insTable"); t.replaceChildren(); const th=h("thead"), hr=h("tr"); ["Effect","ISIN","Koerssymbool","Soort","Sector","Laatste koers"].forEach(x=>hr.append(h("th",null,x))); th.append(hr); t.append(th);
  const tb=h("tbody"); const cell=x=>{ const c=h("td"); c.append(x); return c; };
  PF.instruments.forEach(i=>{ const r=h("tr",i.open?null:"closed"); r.dataset.key=i.key;
    const nm=h("input","inp"); nm.value=i.name; nm.dataset.f="name"; nm.setAttribute("aria-label","Naam");
    const c0=h("td"); c0.append(nm); if(!i.open){ const v=h("div","muted","verkocht"); v.style.fontSize="12px"; c0.append(v); }
    const ys=h("input","inp"); ys.value=i.yahoo||""; ys.dataset.f="yahoo"; ys.placeholder="bijv. VWRL.AS"; ys.setAttribute("aria-label","Koerssymbool");
    const kd=document.createElement("select"); kd.className="inp"; kd.dataset.f="kind"; ["ETF","Aandeel"].forEach(v=>{ const o=h("option",null,v); o.value=v; if(i.kind===v) o.selected=true; kd.append(o); });
    const sc_=h("input","inp"); sc_.value=i.sector||""; sc_.dataset.f="sector"; sc_.setAttribute("list","secList"); sc_.placeholder=i.kind==="ETF"?"bijv. Wereldwijde ETF":"bijv. Technologie";
    r.append(c0,h("td","muted",i.isin||"—"),cell(ys),cell(kd),cell(sc_),h("td",i.last?"muted":"down",i.last?`${nf(i.last[1],2)} ${i.cur} · ${fDs(i.last[0])}`:"geen koers")); tb.append(r); });
  t.append(tb);
  $("insSave").onclick=()=>{ const rows=[...tb.querySelectorAll("tr")].map(r=>{ const o={key:r.dataset.key}; r.querySelectorAll("[data-f]").forEach(f=>{ o[f.dataset.f]=f.value.trim()||null; }); return o; }); CTX.saveInstruments(rows); };
}

/* =====================================================================
   NAVIGATIE & THEMA
   ===================================================================== */
const VIEWS=["overzicht","boekhouding","rapport","posities","dividend","toekomst","data"];
let firstHero=true;
function draw(){
  const v=current();
  if(v==="overzicht"){ renderHero(); renderVs(); renderTreemap("tmOverview"); }
  if(v==="boekhouding") renderBkChart();
  if(v==="rapport") renderTrend();
  if(v==="posities") renderTreemap("tmFull");
  if(v==="dividend") renderDividend();
  if(v==="toekomst") renderFuture();
}
function current(){ const v=location.hash.slice(1); return VIEWS.includes(v)?v:"overzicht"; }
function route(){ const v=current();
  document.querySelectorAll(".view").forEach(x=>x.hidden=x.dataset.view!==v);
  const MORE=["dividend","toekomst","data"];
  document.querySelectorAll("[data-nav]").forEach(a=>{ const on=a.dataset.nav===v||(a.dataset.nav==="meer"&&MORE.includes(v)); a.classList.toggle("active",on); a.toggleAttribute("aria-current",a.dataset.nav===v); });
  $("sheet").classList.remove("on");
  closeDrawer(); window.scrollTo(0,0); draw(); }
window.addEventListener("hashchange",route);
let raf=0; new ResizeObserver(()=>{ cancelAnimationFrame(raf); raf=requestAnimationFrame(draw); }).observe(document.querySelector("main"));
try{ const t=localStorage.getItem("pp2-theme"); if(t) document.documentElement.dataset.theme=t; }catch(e){}
$("themeBtn").addEventListener("click",()=>{ const n=document.documentElement.dataset.theme==="dark"?"light":"dark"; document.documentElement.dataset.theme=n; try{ localStorage.setItem("pp2-theme",n); }catch(e){} draw(); });

$("meerBtn").addEventListener("click",e=>{ e.preventDefault(); e.stopPropagation(); $("sheet").classList.toggle("on"); });
document.addEventListener("click",e=>{ if(!e.target.closest("#sheet")) $("sheet").classList.remove("on"); });
$("freshTxt").textContent=PF.priceAsof?`Koersen ${fDs(PF.priceAsof)}`:"Geen koersen";
if(CTX.priceErr()||PF.missing.length){ $("freshTxt").parentElement.classList.add("warn"); $("freshTxt").parentElement.title=CTX.priceErr()||("Geen koers voor: "+PF.missing.join(", ")); }
$("bkB").replaceChildren(...PF.brokers.map(b=>h("option",null,b)));
{ const bf=$("bkFilter"); bf.replaceChildren(); [["all","Alles"],...PF.brokers.map(b=>[b,b]),["man","Handmatig"]].forEach(([f,l],k)=>{ const x=h("button",k?null:"on",l); x.dataset.f=f; bf.append(x); }); }
{ const ch=$("bkChips"); ch.replaceChildren(); BROKERS.forEach(([b,c])=>{ const x=h("span","chip"), k=h("i","key sq"); k.style.setProperty("--c",c); x.append(k,document.createTextNode(b)); ch.append(x); }); }
LENS.broker.fixed=PF.brokers;
renderBanner(); renderBoek(); renderRapport();
renderStrip(); renderGoals(); renderEq(); renderAlloc(); renderHeat(); renderInsights(); renderFeed(); renderPositions(); renderData();
route(); heroAt(LAST,true);

}

boot();
})();
