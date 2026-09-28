
(()=>{
const $=s=>document.querySelector(s), fmt=n=>Number(n||0).toLocaleString('zh-CN');let records=[],filtered=[];
function elem(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function bars(target,items){const root=$(target);root.replaceChildren();const max=Math.max(1,...items.map(x=>x[1]));for(const [label,value] of items){const row=elem('div',undefined,'barrow');row.style.gridTemplateColumns='minmax(130px,1fr) minmax(70px,1fr) 100px';const name=elem('span',label);name.style.overflowWrap='anywhere';const bar=elem('div',undefined,'bar'),fill=elem('i');fill.style.width=(value/max*100)+'%';bar.append(fill);row.append(name,bar,elem('b',fmt(value)));root.append(row);}if(!items.length)root.append(elem('p','暂无记录','footnote'));}
function metricNumber(value,isRequests){const n=Number(value||0),e=elem('strong',undefined,'metric-value');let number=fmt(n),unit=isRequests?'次':'';if(!isRequests&&n>=1000000){number=(n/1000000).toFixed(2);unit='M';}else if(!isRequests&&n>=1000){number=(n/1000).toFixed(2);unit='K';}e.title=fmt(n)+(isRequests?' 次请求':' Token');e.setAttribute('aria-label',e.title);e.append(elem('span',number,'metric-digits'),elem('span',unit,'metric-unit'));return e;}
function renderRows(){const query=$('#live-search').value.trim().toLowerCase();filtered=records.filter(r=>[r.client,r.client==='unknown'?'未标识调用方':''].join(' ').toLowerCase().includes(query));const root=$('#live-rows');root.replaceChildren();for(const r of filtered){const tr=elem('tr');const values=[new Date(r.timestamp).toLocaleString('zh-CN'),r.client==='unknown'?'未标识调用方':r.client,r.model||'未提供',r.request_id,fmt(r.prompt_tokens),fmt(r.completion_tokens),r.reasoning_tokens?fmt(r.reasoning_tokens):'0 / 未提供',fmt(r.total_tokens),r.status==='success'?'成功':'失败'];values.forEach(v=>tr.append(elem('td',v)));root.append(tr);}$('#live-count').textContent=`当前 ${filtered.length} 条；接口最多返回最近 100 条，并非全部历史明细。`;}
async function refresh(){const button=$('#refresh-live');button.disabled=true;try{const response=await fetch('/dashboard/api/usage?limit=100',{cache:'no-store',signal:AbortSignal.timeout(6000)});if(!response.ok)throw Error('接口返回 '+response.status);const data=await response.json();if(data.object!=='workbuddy.gateway.usage')throw Error('数据源不匹配');const t=data.totals;$('#live-metrics').replaceChildren();for(const [label,value,hint] of [['总 Token',t.total_tokens,'网关记录的历史累计'],['输入 Token',t.prompt_tokens,'直接使用网关输入字段'],['输出 Token',t.completion_tokens,'推理细分不再额外累加'],['请求数',t.requests,`成功 ${fmt(t.successful_requests)} · 失败 ${fmt(t.failed_requests)}`]]){const card=elem('div',undefined,'card metric');card.append(elem('div',label,'metric-label'),metricNumber(value,label==='请求数'),elem('div',hint,'hint'));$('#live-metrics').append(card);}const period=data.period;$('#live-period').textContent=`记录范围：${period.started_at?new Date(period.started_at).toLocaleString('zh-CN'):'暂无'} — ${period.updated_at?new Date(period.updated_at).toLocaleString('zh-CN'):'暂无'} · 读取时间 ${new Date().toLocaleTimeString('zh-CN')}`;bars('#live-days',(data.by_day||[]).map(r=>[r.date,r.total_tokens]));bars('#live-models',[...(data.by_model||[])].sort((a,b)=>b.requests-a.requests).map(r=>[r.model||'未提供',r.requests]));bars('#live-clients',(data.by_client||[]).map(r=>[r.client==='unknown'?'未标识调用方':r.client,r.total_tokens]));bars('#live-types',[['输入',t.prompt_tokens],['输出',t.completion_tokens],['推理（输出细分）',t.reasoning_tokens],['缓存（0 或未提供）',t.cached_tokens]]);records=data.recent||[];renderRows();}catch(error){$('#live-period').textContent='读取失败：'+error.message+'；已显示的数据可能过期。';}finally{button.disabled=false;}}
$('#refresh-live').addEventListener('click',refresh);$('#live-search').addEventListener('input',renderRows);
$('#export-csv').addEventListener('click',()=>{const fields=['timestamp','client','model','request_id','prompt_tokens','completion_tokens','reasoning_tokens','cached_tokens','total_tokens','status'];const quote=v=>'"'+String(v??'').replaceAll('"','""')+'"';const csv='\uFEFF'+[fields,...filtered.map(r=>fields.map(k=>r[k]))].map(row=>row.map(quote).join(',')).join('\r\n');const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const a=elem('a');a.href=url;a.download='workbuddy-gateway-records.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
document.querySelector('#export-usage').addEventListener('click',()=>$('#export-csv').click());refresh();setInterval(refresh,30000);
})();

// Anchor workflow curves to the rendered card edges, including responsive sizing.
(()=>{
 const canvas=document.querySelector('.flow-canvas');
 if(!canvas)return;
 const ns='http://www.w3.org/2000/svg';
 const svg=document.createElementNS(ns,'svg');
 svg.classList.add('workflow-connections');svg.setAttribute('aria-hidden','true');
 canvas.append(svg);
 const plan=canvas.querySelector('.plan'),review=canvas.querySelector('.review');
 const workers=[...canvas.querySelectorAll('.worker-node')];
 function draw(){
  const box=canvas.getBoundingClientRect();
  svg.setAttribute('viewBox',`0 0 ${box.width} ${box.height}`);
  svg.replaceChildren();
  const anchor=(el,side)=>{const r=el.getBoundingClientRect();return {x:r[side]-box.left,y:r.top+r.height/2-box.top};};
  function curve(a,b,dashed){
   const p=document.createElementNS(ns,'path'),bend=(b.x-a.x)*.5;
   p.setAttribute('d',`M ${a.x} ${a.y} C ${a.x+bend} ${a.y}, ${b.x-bend} ${b.y}, ${b.x} ${b.y}`);
   if(dashed)p.setAttribute('stroke-dasharray','4 5');
   svg.append(p);
   const arrow=document.createElementNS(ns,'path');
   arrow.setAttribute('d',`M ${b.x-6} ${b.y-4} L ${b.x} ${b.y} L ${b.x-6} ${b.y+4}`);
   svg.append(arrow);
  }
  workers.forEach((worker,i)=>{curve(anchor(plan,'right'),anchor(worker,'left'),i===1);curve(anchor(worker,'right'),anchor(review,'left'),i===1);});
 }
 let frame;const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(draw);};
 const observer=new ResizeObserver(schedule);
 [canvas,plan,review,...workers].forEach(el=>observer.observe(el));
 window.addEventListener('resize',schedule);document.fonts.ready.then(schedule);schedule();
})();

(()=>{
 const wb=document.querySelector('.primary-worker .worker-state');
 const cli=document.querySelector('.cli-worker .worker-state');
 if(cli){cli.textContent='示意';cli.title='本项目不安装 Claude Code CLI 或桥接服务';}
 async function update(){
  try{
   const r=await fetch('/dashboard/api/agents',{cache:'no-store',signal:AbortSignal.timeout(5000)});
   if(!r.ok)throw Error();
   const d=await r.json();
   const busy=d.activeRequests+d.queuedRequests>0;
   wb.textContent=!d.authenticated?'待授权':busy?'忙':'网关闲';
   wb.dataset.activity=busy?'busy':'unknown';
   wb.title=`仅网关：执行 ${d.activeRequests}，排队 ${d.queuedRequests}；不代表桌面任务状态`;
  }catch{wb.textContent='未连接';wb.dataset.activity='unknown';}
  setTimeout(update,30000);
 }
 update();
})();
