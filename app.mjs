import { resolveResult, direction, rub, dateLabel } from './domain.mjs';
import { loadBundle } from './snapshot.mjs';
const $ = id => document.getElementById(id);
const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let bundle, snapshot, vehicle, selectedModel, selectedGroup, horizon = 3, requestId = 0, renderId = 0, simulatedFailure = false;
const params = new URL(location.href).searchParams;
const now = () => new Date();
const label = { history:'Только история', estimate:'Оценка на дату', scenario:'Учебный сценарий', forecast:'Учебный прогноз', insufficient_data:'Недостаточно данных' };
function options(el, values) {
  el.replaceChildren(...values.map(([value,text]) => { const o = document.createElement('option'); o.value=value; o.textContent=text; return o; }));
}
const unique = values => [...new Set(values)];
function syncSelection(changed='make') {
  const fields=['make','model','generation','year','engine','gearbox','drive','region'];
  let rows=bundle.catalog.models.flatMap(model=>model.groups.map(group=>({...group.characteristics,make:model.make,model:model.model,_model:model,_group:group})));
  for(let i=0;i<fields.length;i++){
    const key=fields[i],el=$(key),old=el.value,values=unique(rows.map(r=>String(r[key])));
    options(el,values.map(v=>[v,v]));
    if(i<=fields.indexOf(changed) && values.includes(old))el.value=old;
    rows=rows.filter(r=>String(r[key])===el.value);
  }
  selectedModel=rows[0]._model;selectedGroup=rows[0]._group;
  $('mileage').value=selectedGroup.characteristics.mileage_km;
}
function announce(text) { $('announcer').textContent = text; }
function empty(title, text, retry=false) {
  $('result').innerHTML = `<div class="empty" role="status"><span class="empty-icon" aria-hidden="true">${retry?'↻':'—'}</span><h2>${escape(title)}</h2><p>${escape(text)}</p>${retry?'<button id="retry" class="secondary" type="button">Повторить загрузку</button>':''}</div>`;
  $('retry')?.addEventListener('click',load);
}
function chart(v, result) {
  const past = v.history.map(p=>({date:new Date(`${p.date}T00:00:00Z`), price:p.price}));
  const anchor = past.at(-1);
  const future = result.projection.filter(p=>p.months<=horizon).map(p=>{const date=new Date(p.date || `${v.data_as_of}T00:00:00Z`);if(!p.date)date.setUTCMonth(date.getUTCMonth()+p.months);return {...p,date};});
  const all=[...past,...future], width=680,height=260,L=65,R=16,T=22,B=35;
  if(!all.length)return '<p class="muted">История для этой группы не предоставлена.</p>';
  const minT=all[0].date.getTime(),maxT=all.at(-1).date.getTime();
  const prices=all.flatMap(p=>[p.lower??p.price,p.upper??p.price]);
  let lo=Math.min(...prices),hi=Math.max(...prices),padding=(hi-lo)*.2||hi*.05;lo-=padding;hi+=padding;
  const x=d=>L+((d.getTime()-minT)/(maxT-minT||1))*(width-L-R);
  const y=p=>T+(hi-p)/(hi-lo)*(height-T-B);
  const point=p=>`${x(p.date).toFixed(1)},${y(p.price).toFixed(1)}`;
  const lastX=anchor?x(anchor.date):null;
  const hasBand=future.length>0 && future.every(p=>Number.isFinite(p.lower)&&Number.isFinite(p.upper));
  const band=hasBand?[...(anchor?[{date:anchor.date,lower:anchor.price,upper:anchor.price}]:[]),...future]:[];
  const bandPath=band.length?`<polygon points="${[...band.map(p=>`${x(p.date)},${y(p.upper)}`),...band.toReversed().map(p=>`${x(p.date)},${y(p.lower)}`)].join(' ')}" fill="#ec7445" fill-opacity=".13"/>`:'';
  const grids=Array.from({length:5},(_,i)=>{const value=lo+(hi-lo)*i/4,yy=y(value);return `<line x1="${L}" y1="${yy}" x2="${width-R}" y2="${yy}" stroke="#e9eeee"/><text x="${L-10}" y="${yy+4}" text-anchor="end" font-size="10" fill="#839299">${(value/1e6).toLocaleString('ru-RU',{maximumFractionDigits:2})}</text>`;}).join('');
  const ticks=[all[0],...(anchor?[anchor]:[]),all.at(-1)].filter((p,i,a)=>a.findIndex(q=>q.date.getTime()===p.date.getTime())===i);
  const dates=ticks.map(p=>`<text x="${x(p.date)}" y="${height-10}" text-anchor="middle" font-size="10" fill="#839299">${escape(p.date.toLocaleDateString('ru-RU',{month:'short',year:'2-digit',timeZone:'UTC'}))}</text>`).join('');
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Учебные синтетические значения: история и доступная будущая динамика"><text x="${L}" y="10" font-size="9" fill="#839299">млн ₽ · учебные значения</text>${grids}${bandPath}${future.length&&anchor?`<line x1="${lastX}" y1="${T}" x2="${lastX}" y2="${height-B}" stroke="#b8c8cc" stroke-dasharray="3 5"/>`:''}<polyline points="${past.map(point).join(' ')}" fill="none" stroke="#186c87" stroke-width="2.5" stroke-linejoin="round"/>${future.length?`<polyline points="${[...(anchor?[anchor]:[]),...future].map(point).join(' ')}" fill="none" stroke="#ec7445" stroke-width="2.5" stroke-dasharray="5 5"/>`:''}${anchor?`<circle cx="${lastX}" cy="${y(anchor.price)}" r="4.5" fill="#186c87" stroke="white" stroke-width="2"/>`:''}${dates}</svg>`;
}
async function render() {
  if (!selectedModel) return;
  const id=++renderId,model=selectedModel,group=selectedGroup;
  $('result').setAttribute('aria-busy','true');
  try { const data=await bundle.loadModel(model);if(id!==renderId)return;snapshot=data;vehicle=data.vehicles.find(v=>v.id===group.id); }
  catch {if(id===renderId){$('result').setAttribute('aria-busy','false');empty('Не удалось загрузить группу','Файл недоступен, повреждён или относится к другой версии. Цена не подставлена.',true);}return;}
  $('result').setAttribute('aria-busy','false');
  if(params.get('case')==='stale')vehicle={...vehicle,data_as_of:'2025-11-01',history:vehicle.history.map(p=>({...p,date:p.date.replace('2026','2025')}))};
  const result=resolveResult(vehicle,{region:$('region').value,year:Number($('year').value),mileage:Number($('mileage').value)},now());
  if(result.mode==='insufficient_data') {empty('Недостаточно данных',result.reason);announce('Недостаточно данных для выбранных параметров');return;}
  const available=new Set(result.projection.map(p=>p.months));
  if(available.size&&!available.has(horizon))horizon=[...available][0];
  const projection=result.projection.filter(p=>p.months<=horizon);
  const last=projection.at(-1);
  const title=`${vehicle.make} ${vehicle.model}`;
  const historical=result.mode==='history';
  $('result').innerHTML = `
    <article class="summary"><div class="summary-top"><div><p class="eyebrow">УЧЕБНЫЙ ОБЗОР / ГРУППА АНАЛОГОВ</p><h2>${escape(title)}</h2></div><span class="mode-pill">${label[result.mode]}</span></div>
    <p class="summary-sub">${vehicle.year} · ${escape(vehicle.generation)} · ${escape(vehicle.engine)} · ${escape(vehicle.region)}</p>
    <div class="price-row"><div><div class="price">${Number.isFinite(result.estimate)?rub(result.estimate):'Оценка не задана'}</div><div class="price-caption">${vehicle.value_kind==='estimate'&&!historical?'Учебная оценка на дату набора':'Последняя точка учебной истории'} · не цена сделки</div></div><div class="range">${last&&Number.isFinite(last.lower)?`${rub(last.lower)} — ${rub(last.upper)}`:last?`${rub(last.price)} · точка сценария`:vehicle.estimate_interval&&!historical?`${rub(vehicle.estimate_interval.lower_rub)} — ${rub(vehicle.estimate_interval.upper_rub)}`:'Будущая динамика не опубликована'}<small>${last?'Вымышленный результат · не проверенный прогноз рынка':vehicle.estimate_interval&&!historical?'Вымышленный интервал оценки · не гарантия':'Нет будущего результата для выбранного горизонта'}</small></div></div>
    <div class="summary-bottom"><span>Дата наблюдений: ${dateLabel(vehicle.data_as_of)}</span><span>${vehicle.n_unique} условных аналогов</span><span>Пробег группы: ${vehicle.mileage_band[0]/1000} тыс. км · точное совпадение</span></div></article>
    ${result.warnings.length?`<div class="notice" role="note">${result.warnings.map(escape).join(' ')}</div>`:''}
    <article class="chart-card"><div class="chart-heading"><h3>История и возможная динамика</h3><div class="horizons" role="group" aria-label="Доступные горизонты">${[1,3,6,12].map(h=>`<button type="button" data-horizon="${h}" aria-pressed="${h===horizon&&available.has(h)}" ${available.has(h)?'':'disabled'}>${h} мес.</button>`).join('')}</div></div><p class="chart-caption">Весь график — вымышленный пример. Историческая часть тоже синтетическая.</p><div class="chart-wrap">${chart(vehicle,result)}</div><div class="legend"><span><i></i>Учебная история</span>${projection.length?`<span><i class="dash"></i>${result.mode==='forecast'?'Учебный прогноз':'Сценарий'}</span>${last&&Number.isFinite(last.lower)?'<span><i class="band"></i>Иллюстративный диапазон</span>':''}`:''}</div><p class="forecast-note"><strong>${direction(result.estimate,last)}.</strong> ${escape(vehicle.scenario_label&&result.mode==='scenario'?vehicle.scenario_label:last?'Это не рекомендация покупать или продавать.':'Для выбранного горизонта нет опубликованной будущей точки.')}</p></article>
    <div class="details-grid"><article class="detail-card"><h3>Источник и свежесть</h3><p><strong>${escape(vehicle.source_label)}</strong></p><p>Версия: ${escape(snapshot.run_id)}</p><p>Реальные площадки не подключены.</p></article><article class="detail-card"><h3>Что проверено</h3><p><strong>Только поведение интерфейса</strong></p><p>Все backtest-метрики и аналоги в наборе тоже вымышлены.</p><a href="#methodology">О будущей методике ↗</a></article></div>`;
  document.querySelectorAll('[data-horizon]').forEach(b=>b.addEventListener('click',()=>{horizon=Number(b.dataset.horizon);render();document.querySelector(`[data-horizon="${horizon}"]`)?.focus();}));
  announce(`Учебный обзор ${title}. ${label[result.mode]}. Все цены вымышлены.`);
}
async function load() {
  const id=++requestId;
  ++renderId;
  $('result').setAttribute('aria-busy','true'); $('submit').disabled=true;
  $('result').innerHTML='<div class="placeholder" role="status">Загружаем учебный пример…</div>';
  try {
    if(params.get('case')==='error'&&!simulatedFailure){simulatedFailure=true;throw new Error('Учебный отказ загрузки');}
    const nextBundle=await loadBundle(new URL('./data/fixture-v001/',location.href));
    if(id!==requestId)return;
    bundle=nextBundle;syncSelection();
    const target={forecast:'2020',estimate:'2019',scenario:'2021',insufficient:'2022'}[params.get('case')];
    if(target){$('year').value=target;syncSelection('year');}
    await render();
  } catch(error) {
    if(id!==requestId)return;
    empty('Не удалось загрузить пример','Данные не получены или не прошли проверку. Мы не заменяем их случайными ценами. Попробуйте ещё раз.',true);
    announce('Ошибка загрузки данных');
  } finally {if(id===requestId){$('result').setAttribute('aria-busy','false');$('submit').disabled=false;}}
}
for(const key of ['make','model','generation','year','engine','gearbox','drive','region']) $(key).addEventListener('change',()=>{if(bundle){syncSelection(key);render();}});
$('vehicle-form').addEventListener('submit',e=>{e.preventDefault();if($('vehicle-form').reportValidity())render();});
load();
