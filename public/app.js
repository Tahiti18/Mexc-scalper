<script>
// ==== CONFIG ====
const BASE = "https://mexc-scalper-production.up.railway.app";

// token persistence
function getToken() { return localStorage.getItem("dash_token") || ""; }
function setToken(t){ localStorage.setItem("dash_token", t||""); }

// common fetch with token
async function jget(path){
  const r = await fetch(`${BASE}${path}`, {
    headers: { "X-Dashboard-Token": getToken() }
  });
  if(!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}
async function textget(path){
  const r = await fetch(`${BASE}${path}`, {
    headers: { "X-Dashboard-Token": getToken() }
  });
  if(!r.ok) throw new Error(`${path} ${r.status}`);
  return r.text();
}
async function jpost(path, body){
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type":"application/json",
      "X-Dashboard-Token": getToken()
    },
    body: JSON.stringify(body||{})
  });
  if(!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

// DOM helpers
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

function fmt(n, d=2){ return Number(n||0).toFixed(d); }
function nowISO(){ return new Date().toISOString().replace('T',' ').slice(0,19); }

// ==== KPI update ====
async function loadStats(){
  try{
    const s = await jget("/stats");
    $("#k-trades-today").textContent = s.tradesToday;
    $("#k-trades-hour").textContent  = s.tradesLastHour;
    $("#k-pnl-today").textContent    = fmt(s.pnlToday, 4);
    $("#k-dry").textContent          = String(s.dry).toUpperCase();
    $("#k-daily-key").textContent    = s.dailyKey || "-";

    // cooldown + halted badges
    const cd = Object.entries(s.cooldown||{});
    $("#cooldowns").innerHTML = cd.length
      ? cd.map(([sym,sec])=>`<span class="pill warn">${sym}: ${sec}s</span>`).join(" ")
      : `<span class="muted">none</span>`;

    const halted = Object.entries(s.halted||{});
    $("#halted").innerHTML = halted.length
      ? halted.map(([sym,val])=>`<span class="pill danger">${sym}: ${val}</span>`).join(" ")
      : `<span class="muted">none</span>`;

  }catch(e){
    console.error(e);
  }
}

async function loadDaily(){
  try{
    const d = await jget("/stats/daily");
    // equity line
    const labels = d.map(x=>x.day);
    const eq     = d.map(x=>x.equity);
    drawLine("#equityChart", labels, eq, "Equity");

    // wins / losses bar
    const wins = d.map(x=>x.wins||0);
    const losses = d.map(x=>x.losses||0);
    drawBars("#wlChart", labels, [ {label:"Wins", data:wins}, {label:"Losses", data:losses} ]);
  }catch(e){ console.error(e); }
}

async function loadPNL(){
  try{
    const csv = await textget("/pnl.csv");
    $("#pnlpre").textContent = csv;
    // simple tail parse for last 20 rows
    const rows = csv.trim().split(/\n/).slice(1).slice(-20).map(r=>r.split(","));
    $("#pnltable tbody").innerHTML = rows.map(r=>`
      <tr>
        <td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td>
        <td class="num">${fmt(r[3])}</td><td class="num">${fmt(r[4])}</td>
        <td class="num">${fmt(r[5],6)}</td><td class="num ${Number(r[6])>=0?'pos':'neg'}">${fmt(r[6],6)}</td>
      </tr>`).join("");
  }catch(e){ console.error(e); }
}

async function loadLogs(){
  try{
    const csv = await textget("/logs.csv");
    $("#logpre").textContent = csv;
  }catch(e){ console.error(e); }
}

// ==== Charts (Chart.js via CDN) ====
const charts = {};
function drawLine(sel, labels, data, label){
  const ctx = document.querySelector(sel);
  charts[sel]?.destroy?.();
  charts[sel] = new Chart(ctx, {
    type:"line",
    data:{ labels, datasets:[{ label, data}]},
    options:{ responsive:true, maintainAspectRatio:false }
  });
}
function drawBars(sel, labels, datasets){
  const ctx = document.querySelector(sel);
  charts[sel]?.destroy?.();
  charts[sel] = new Chart(ctx, {
    type:"bar",
    data:{ labels, datasets },
    options:{ responsive:true, maintainAspectRatio:false, grouped:true }
  });
}

// ==== SSE stream ====
let es=null;
function startStream(){
  stopStream();
  const u = new URL(`${BASE}/stream`);
  u.searchParams.set("token", getToken());
  es = new EventSource(u.toString());
  es.onmessage = (ev)=>{
    const obj = safeJSON(ev.data);
    const line = `[${nowISO()}] ${ev.data}`;
    const pre = $("#live");
    pre.textContent += line + "\n";
    pre.scrollTop = pre.scrollHeight;
    // light refresh on certain events
    if(obj && (obj.type==="fill" || obj.type==="exec" || obj.type==="auto-close")){
      loadStats(); loadPNL();
    }
  };
  es.onerror = ()=>{/* keep alive */};
}
function stopStream(){
  if(es){ es.close(); es=null; }
}
function safeJSON(s){ try{ return JSON.parse(s); }catch{ return null; } }

// ==== Admin & Sim ====
async function simFill(){
  const sym = $("#sym").value || "BTC/USDT:USDT";
  const side= $("#simSide").value || "buy";
  const px  = Number($("#simPx").value || 19000);
  const amt = Number($("#simAmt").value || 0.001);
  await jpost("/admin/simfill", { symbol:sym, side, price:px, amount:amt, fee:0 });
  await loadStats(); await loadPNL();
}
async function simSeq(which){
  const sym = $("#sym").value || "BTC/USDT:USDT";
  const ok = await jpost("/admin/"+which, { symbol:sym });
  $("#msg").textContent = JSON.stringify(ok);
  await loadStats(); await loadPNL();
}
async function cooldown(){
  const sym = $("#sym").value || "BTC/USDT:USDT";
  const sec = Number($("#cdSec").value||120);
  await jpost("/admin/cooldown", { symbol:sym, seconds:sec });
  await loadStats();
}
async function halt(){ const sym = $("#sym").value || "BTC/USDT:USDT"; await jpost("/admin/halt", { symbol:sym }); await loadStats(); }
async function unhalt(){ const sym = $("#sym").value || "BTC/USDT:USDT"; await jpost("/admin/unhalt", { symbol:sym }); await loadStats(); }
async function haltAll(){ await jpost("/admin/halt_all", {}); await loadStats(); }
async function unhaltAll(){ await jpost("/admin/unhalt_all", {}); await loadStats(); }
async function resetAll(){ await jpost("/admin/reset", {}); await loadStats(); await loadPNL(); }

// token input
function bindToken(){
  const inp=$("#token");
  inp.value = getToken();
  $("#saveToken").onclick = ()=>{
    setToken(inp.value.trim());
    $("#msg").textContent = "Token saved.";
    // reconnect stream with new token
    startStream();
    loadStats(); loadDaily(); loadPNL(); loadLogs();
  };
}

// init
window.addEventListener("DOMContentLoaded", ()=>{
  bindToken();
  $("#reload").onclick = ()=>{ loadStats(); loadDaily(); loadPNL(); loadLogs(); };
  $("#simFill").onclick = simFill;
  $("#simImpulse").onclick = ()=>simSeq("simseq");
  $("#simStrat1").onclick = ()=>simSeq("simstrategy");
  $("#simStrat2").onclick = ()=>simSeq("simstrategy2");
  $("#cooldownBtn").onclick = cooldown;
  $("#haltBtn").onclick = halt;
  $("#unhaltBtn").onclick = unhalt;
  $("#haltAllBtn").onclick = haltAll;
  $("#unhaltAllBtn").onclick = unhaltAll;
  $("#resetBtn").onclick = resetAll;

  // first load
  loadStats(); loadDaily(); loadPNL(); loadLogs();
  startStream();
});
</script>
