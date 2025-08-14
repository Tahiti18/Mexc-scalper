
async function loadHealth(){
  const r = await fetch('/health',{cache:'no-store'});
  const j = await r.json();
  document.getElementById('h').textContent = JSON.stringify(j,null,2);
}
setInterval(loadHealth, 3000);
loadHealth();
