(async()=>{
  const h=document.getElementById('h');
  async function refresh(){
    try{
      const r=await fetch('/health'); const j=await r.json();
      h.textContent=JSON.stringify(j,null,2);
    }catch(e){
      h.textContent=String(e);
    }
  }
  refresh();
  setInterval(refresh, 3000);
})();