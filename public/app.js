
const BASE = location.origin;  // same origin as server
document.getElementById('pnlcsv').href  = BASE + "/pnl.csv";
document.getElementById('logscsv').href = BASE + "/logs.csv";
document.getElementById('config').href  = BASE + "/config";

const kDefs = [
  { id:"trades", label:"Trades" },
  { id:"winrate", label:"Win Rate" },
  { id:"net", label:"Net PnL (USDT)" },
  { id:"gprofit", label:"Gross Profit" },
  { id:"gloss", label:"Gross Loss" },
  { id:"pf", label:"Profit Factor" },
  { id:"avgwin", label:"Avg Win" },
  { id:"avgloss", label:"Avg Loss" },
  { id:"dd", label:"Max Drawdown" }
];

function el(html){ const d=document.createElement('div'); d.innerHTML=html.trim(); return d.firstChild; }
const kpiWrap = document.getElementById('kpis');
kDefs.forEach(k => kpiWrap.appendChild(el(`<div class="kpi"><div>${k.label}</div><div class="v" id="${k.id}">—</div></div>`)));

const eqChart = new Chart(document.getElementById('eq'), {
  type:'line',
  data:{ labels:[], datasets:[{ label:'Equity (USDT)', data:[], tension:0.2 }]},
  options:{ animation:false, plugins:{legend:{display:false}}, scales:{x:{ticks:{autoSkip:true,maxRotation:0}}} 
});
const ddChart = new Chart(document.getElementById('dd'), {
  type:'line',
  data:{ labels:[], datasets:[{ label:'Drawdown (USDT)', data:[], tension:0.2 }]},
  options:{ animation:false, plugins:{legend:{display:false}}, scales:{x:{ticks:{autoSkip:true,maxRotation:0}}} 
});
const histChart = new Chart(document.getElementById('hist'), {
  type:'bar',
  data:{ labels:[], datasets:[{ label:'Trades', data:[] }]},
  options:{ animation:false, plugins:{legend:{display:false}} }
});

async function fetchJSON(u){ const r=await fetch(u,{cache:'no-store'}); if(!r.ok) throw new Error(r.status); return r.json(); }
async function fetchText(u){ const r=await fetch(u,{cache:'no-store'}); if(!r.ok) throw new Error(r.status); return r.text(); }

async function refresh(){
  try{
    const health = await fetchJSON(BASE + "/health");
    document.getElementById('drypill').textContent = "DRY: " + String(health.dry);

    const mp = document.getElementById('masterpill');
    if (health.globalHalt) { mp.textContent='MASTER: HALTED'; mp.style.background='#8b1a1a'; mp.style.color='#ffd7d7'; }
    else { mp.textContent='MASTER: LIVE'; mp.style.background=''; mp.style.color=''; }

    const sym = (document.getElementById('sym').value || 'BTC/USDT:USDT').trim().toUpperCase();
    const halted = health.halted && Object.prototype.hasOwnProperty.call(health.halted, sym);
    const pill = document.getElementById('haltpill');
    if (health.globalHalt || halted) { pill.textContent='HALTED'; pill.style.background='#5a1a1a'; pill.style.color='#ffd7d7'; }
    else { pill.textContent='LIVE'; pill.style.background=''; pill.style.color=''; }
  } catch {}

  const s = await fetchJSON(BASE + "/stats");
  document.getElementById('trades').textContent  = s.counts.trades;
  document.getElementById('winrate').textContent = s.quality.winRate.toFixed(2) + "%";
  document.getElementById('net').textContent     = s.pnl.net.toFixed(4);
  document.getElementById('gprofit').textContent = s.pnl.grossProfit.toFixed(4);
  document.getElementById('gloss').textContent   = s.pnl.grossLoss.toFixed(4);
  document.getElementById('pf').textContent      = s.quality.profitFactor.toFixed(3);
  document.getElementById('avgwin').textContent  = s.quality.avgWin.toFixed(4);
  document.getElementById('avgloss').textContent = s.quality.avgLoss.toFixed(4);
  document.getElementById('dd').textContent      = s.risk.maxDrawdown.toFixed(4);
  document.getElementById('ddval').textContent   = s.risk.maxDrawdown.toFixed(4);

  document.getElementById('cwin').textContent  = s.streaks.currentWins;
  document.getElementById('closs').textContent = s.streaks.currentLosses;
  document.getElementById('mwin').textContent  = s.streaks.maxWins;
  document.getElementById('mloss').textContent = s.streaks.maxLosses;

  const eqLabels = s.equity.map(p => new Date(p.ts).toISOString().slice(11,19));
  eqChart.data.labels = eqLabels;
  eqChart.data.datasets[0].data = s.equity.map(p => p.equity);
  eqChart.update();

  const ddLabels = s.drawdown.map(p => new Date(p.ts).toISOString().slice(11,19));
  ddChart.data.labels = ddLabels;
  ddChart.data.datasets[0].data = s.drawdown.map(p => p.dd);
  ddChart.update();

  histChart.data.labels = s.hist.labels;
  histChart.data.datasets[0].data = s.hist.bins;
  histChart.update();

  const csv = await fetchText(BASE + "/pnl.csv");
  const lines = csv.trim().split(/\r?\n/).slice(1).reverse();
  const body = document.querySelector('#trades tbody');
  body.innerHTML = '';
  lines.slice(0, 25).forEach(l=>{
    const [ts,symbol,side,price,amount,fee,realized] = l.split(',');
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${(ts||'').replace('T',' ').slice(0,19)}</td><td>${symbol||''}</td><td>${side||''}</td><td>${Number(price||0).toFixed(4)}</td><td>${Number(amount||0).toFixed(6)}</td><td>${Number(realized||0).toFixed(6)}</td><td>${Number(fee||0).toFixed(6)}</td>`;
    body.appendChild(tr);
  });
}

async function refreshDaily(){
  const d = await fetchJSON(BASE + "/stats/daily");
  const body = document.querySelector('#daily tbody');
  body.innerHTML = '';
  (d.daily || []).slice(-30).forEach(row=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${row.key}</td><td>${row.trades}</td><td>${row.wins}</td><td>${row.losses}</td>` +
                   `<td>${row.winRate.toFixed(2)}%</td><td>${row.profitFactor.toFixed(2)}</td>` +
                   `<td>${row.grossProfit.toFixed(4)}</td><td>${row.grossLoss.toFixed(4)}</td><td>${row.net.toFixed(4)}</td>`;
    body.appendChild(tr);
  });
}

refresh();
refreshDaily();
setInterval(()=>{ refresh(); refreshDaily(); }, 4000);

// Live SSE feed
try{
  const ev = new EventSource(BASE + "/stream");
  const live = document.getElementById('live');
  function push(line){
    const time = new Date().toISOString().slice(11,19);
    live.textContent += `[${time}] ${line}\n`;
    live.scrollTop = live.scrollHeight;
  }
  ev.addEventListener('hello', (e)=> push('SSE connected'));
  ev.addEventListener('log',   (e)=> { const d=JSON.parse(e.data); push(d.line); });
  ev.addEventListener('exec',  (e)=> { const d=JSON.parse(e.data); push(`EXEC ${d.signal} ${d.symbol} lev=${d.lev} notional=${d.notionalUSDT}`); });
  ev.addEventListener('fill',  (e)=> { const d=JSON.parse(e.data); push(`FILL ${d.symbol} ${d.side} px=${d.price} amt=${d.amount} realized=${d.realized}`); });
}catch{}

// ---- Admin posts (real)
const tokInput = document.getElementById('admintok');
document.getElementById('saveTok').onclick = () => {
  localStorage.setItem('dash_token', tokInput.value || '');
  document.getElementById('simmsg').textContent = 'Token saved';
  setTimeout(()=> document.getElementById('simmsg').textContent='', 1500);
};
tokInput.value = localStorage.getItem('dash_token') || '';

function val(id){ return (document.getElementById(id).value || '').trim(); }
async function postAdmin(path, body={}) {
  const token = localStorage.getItem('dash_token') || '';
  const res = await fetch(BASE + path, {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'X-Dashboard-Token': token },
    body: JSON.stringify(body)
  });
  if(!res.ok) throw new Error(await res.text());
  return res.json();
}
document.getElementById('btnHalt').onclick = async ()=>{
  try{ const symbol = (val('sym') || 'BTC/USDT:USDT').toUpperCase(); await postAdmin('/admin/halt', { symbol }); document.getElementById('simmsg').textContent = `Halted ${symbol}`; setTimeout(()=> document.getElementById('simmsg').textContent='', 1500); }
  catch(e){ document.getElementById('simmsg').textContent = 'Error: '+e.message; }
};
document.getElementById('btnUnhalt').onclick = async ()=>{
  try{ const symbol = (val('sym') || 'BTC/USDT:USDT').toUpperCase(); await postAdmin('/admin/unhalt', { symbol }); document.getElementById('simmsg').textContent = `Unhalted ${symbol}`; setTimeout(()=> document.getElementById('simmsg').textContent='', 1500); }
  catch(e){ document.getElementById('simmsg').textContent = 'Error: '+e.message; }
};
document.getElementById('btnCooldown').onclick = async ()=>{
  try{ const symbol = (val('sym') || 'BTC/USDT:USDT').toUpperCase(); const seconds = Math.max(1, Number(val('cdsecs') || 60)); await postAdmin('/admin/cooldown', { symbol, seconds }); document.getElementById('simmsg').textContent = `Cooldown ${symbol} for ${seconds}s`; setTimeout(()=> document.getElementById('simmsg').textContent='', 1500); }
  catch(e){ document.getElementById('simmsg').textContent = 'Error: '+e.message; }
};
document.getElementById('btnHaltAll').onclick = async ()=>{
  try{ await postAdmin('/admin/halt_all', {}); document.getElementById('simmsg').textContent = 'MASTER HALT enabled'; setTimeout(()=> document.getElementById('simmsg').textContent='', 1500); }
  catch(e){ document.getElementById('simmsg').textContent = 'Error: '+e.message; }
};
document.getElementById('btnUnhaltAll').onclick = async ()=>{
  try{ await postAdmin('/admin/unhalt_all', {}); document.getElementById('simmsg').textContent = 'MASTER HALT disabled'; setTimeout(()=> document.getElementById('simmsg').textContent='', 1500); }
  catch(e){ document.getElementById('simmsg').textContent = 'Error: '+e.message; }
};
