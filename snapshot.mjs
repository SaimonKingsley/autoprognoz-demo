// Consumer for subrosa5's draft 0.1.0. Real data remains deliberately disabled.
import { validateSnapshot } from './domain.mjs';
const VERSION = '0.1.0';
const fail = message => { throw new Error(message); };
const dateOK = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v;
const positive = v => Number.isFinite(v) && v > 0;
function identity(body, manifest) {
  for (const key of ['schema_version','run_id','is_fixture']) if (body[key] !== manifest[key]) fail(`Mixed snapshot: ${key}`);
}
function safePath(path, run) {
  if (typeof path !== 'string' || path.includes('..') || path.includes('\\') || !new RegExp(`^(catalog\\.json|data/${run}/[a-z0-9_/-]+\\.json)$`).test(path)) fail('Unsafe snapshot path');
  return path;
}
function interval(point) {
  const i = point.interval;
  if (!positive(point.price_rub) || !i || !positive(i.lower_rub) || !positive(i.upper_rub) || i.lower_rub > point.price_rub || point.price_rub > i.upper_rub || !positive(i.nominal_coverage) || i.nominal_coverage >= 1) fail('Invalid interval');
}
export function adaptModel(manifest, model, shard) {
  identity(shard,manifest);
  if (shard.make !== model.make || shard.model !== model.model || !Array.isArray(shard.results)) fail('Wrong model shard');
  const groups = new Map(model.groups.map(g=>[g.id,g]));
  const results = new Map(shard.results.map(r=>[r.group_id,r]));
  if (results.size !== shard.results.length || results.size !== groups.size || [...groups.keys()].some(k=>!results.has(k))) fail('Group mismatch');
  const sourceIds = new Set(manifest.sources.map(s=>s.id));
  const vehicles = model.groups.map(group => {
    const r=results.get(group.id), c=group.characteristics;
    if (!model.supported_modes.includes(r.mode) || !Array.isArray(r.quality_flags) || !r.quality_flags.includes('synthetic') || !Array.isArray(r.source_ids) || !r.source_ids.length || r.source_ids.some(s=>!sourceIds.has(s))) fail('Unapproved result/source');
    if (!Array.isArray(r.history) || !Array.isArray(r.forecast)) fail('Missing result series');
    if (r.data_as_of !== null && r.data_as_of !== manifest.data_as_of) fail('Mixed data dates');
    if (r.mode !== 'insufficient_data' && (!dateOK(r.data_as_of) || !Number.isInteger(r.n_unique) || r.n_unique < 0)) fail('Missing observation metadata');
    if (r.mode === 'insufficient_data' && (r.history.length || r.forecast.length || r.estimate !== null || r.scenario !== null || typeof r.refusal_reason !== 'string' || !r.refusal_reason.trim() || !(r.n_unique === null || r.n_unique === 0))) fail('Invalid refusal');
    if (r.mode !== 'insufficient_data' && r.refusal_reason !== null) fail('Unexpected refusal');
    if (r.mode !== 'estimate' && r.estimate !== null) fail('Unexpected estimate');
    if (r.mode !== 'forecast' && r.forecast.length) fail('Unexpected forecast');
    if (r.mode !== 'scenario' && r.scenario !== null) fail('Unexpected scenario');
    const history=r.history.map(p=>({date:p.date,price:p.price_rub}));
    let projection=[];
    if(r.mode==='estimate')interval(r.estimate);
    if(r.mode==='forecast') {
      if(!r.forecast.length)fail('Empty forecast');
      projection=[...r.forecast].sort((a,b)=>a.horizon_months-b.horizon_months).map(p=>{
        interval(p);
        const b=p.backtest;
        if(!b || b.decision!=='publish' || !Number.isInteger(b.origins) || b.origins<1 || !Number.isFinite(b.wape) || b.wape<0 || !Number.isFinite(b.baseline_wape) || b.baseline_wape<0 || ![1,3,6,12].includes(p.horizon_months) || !dateOK(p.target_date))fail('Invalid forecast admission');
        const origin=new Date(r.data_as_of),target=new Date(p.target_date);
        const months=(target.getUTCFullYear()-origin.getUTCFullYear())*12+target.getUTCMonth()-origin.getUTCMonth();
        if(months!==p.horizon_months || target<=origin)fail('Forecast horizon/date mismatch');
        return {months:p.horizon_months,date:p.target_date,price:p.price_rub,lower:p.interval.lower_rub,upper:p.interval.upper_rub};
      });
    }
    if(r.mode==='scenario') {
      if(!r.scenario || typeof r.scenario.label!=='string' || !Array.isArray(r.scenario.assumptions) || !r.scenario.assumptions.length || !Array.isArray(r.scenario.points) || !r.scenario.points.length)fail('Invalid scenario');
      projection=r.scenario.points.map(p=>{
        if(!dateOK(p.date) || !positive(p.price_rub) || p.date<=r.data_as_of)fail('Invalid scenario point');
        const d=new Date(p.date),o=new Date(r.data_as_of),months=(d.getUTCFullYear()-o.getUTCFullYear())*12+d.getUTCMonth()-o.getUTCMonth();
        return {months,date:p.date,price:p.price_rub,lower:null,upper:null};
      });
    }
    return {id:group.id,make:model.make,model:model.model,generation:c.generation,year:c.year,engine:c.engine,gearbox:c.gearbox,drive:c.drive,region:c.region,mileage_band:[c.mileage_km,c.mileage_km],mode:r.mode,data_as_of:r.data_as_of,n_unique:r.n_unique,
      estimate:r.estimate?.price_rub ?? history.at(-1)?.price ?? null,
      value_kind:r.estimate?'estimate':'last_observation',estimate_interval:r.estimate?.interval??null,
      history,projection,quality_passed:r.mode==='forecast',refusal_reason:r.refusal_reason,
      scenario_label:r.scenario?.label??null,assumptions:r.scenario?.assumptions??[],source_label:r.source_ids.map(id=>manifest.sources.find(s=>s.id===id).label).join('; ')};
  });
  if([...new Set(shard.results.map(r=>r.mode))].sort().join() !== [...model.supported_modes].sort().join())fail('Supported modes mismatch');
  return validateSnapshot({schema_version:'0.1-draft',is_fixture:true,run_id:manifest.run_id,vehicles});
}
export async function loadBundle(base, { fetcher=globalThis.fetch, subtle=globalThis.crypto?.subtle, bootstrap=null } = {}) {
  const root=new URL(base);
  if(!subtle)fail('SHA-256 unavailable');
  let embedded=null;
  if(bootstrap){
    if(typeof bootstrap!=='string'||bootstrap.length>23000)fail('Invalid fixture bootstrap size');
    embedded=JSON.parse(bootstrap);
    if(embedded?.format!=='fixture-bootstrap-1'||embedded.run_id!=='fixture-v001'||!embedded.files||Array.isArray(embedded.files)||Object.keys(embedded.files).length!==3||!Object.hasOwn(embedded.files,'manifest.json'))fail('Invalid fixture bootstrap');
    let total=0;
    for(const [path,encoded] of Object.entries(embedded.files)){
      if(path!=='manifest.json')safePath(path,embedded.run_id);
      if(typeof encoded!=='string'||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))fail('Invalid bootstrap encoding');
      total+=atob(encoded).length;
    }
    if(total>16384)fail('Invalid fixture bootstrap size');
  }
  const read=async(path,entry)=>{
    const u=new URL(path,root);if(u.origin!==root.origin || !u.pathname.startsWith(root.pathname))fail('Snapshot escaped root');
    let raw;
    if(embedded&&Object.hasOwn(embedded.files,path))raw=Uint8Array.from(atob(embedded.files[path]),c=>c.charCodeAt(0));
    else{
      const response=await fetcher(u,{signal:AbortSignal.timeout(8000),cache:'no-cache'});
      if(!response.ok)fail('Snapshot HTTP error');
      raw=new Uint8Array(await response.arrayBuffer());
    }
    if(raw.length>2_000_000)fail('Snapshot too large');
    if(entry){
      const digest=[...new Uint8Array(await subtle.digest('SHA-256',raw))].map(b=>b.toString(16).padStart(2,'0')).join('');
      if(raw.length!==entry.bytes || digest!==entry.sha256)fail('Snapshot integrity mismatch');
    }
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
  };
  const m=await read('manifest.json');
  if(embedded&&embedded.run_id!==m.run_id)fail('Mixed bootstrap run');
  if(m.schema_version!==VERSION || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(m.run_id) || m.is_fixture!==true || m.status!=='fixture' || m.currency!=='RUB' || m.price_kind!=='asking')fail('Only synthetic 0.1.0 accepted');
  if(!Number.isFinite(Date.parse(m.generated_at)) || (m.data_as_of!==null&&(!dateOK(m.data_as_of)||new Date(m.generated_at).toISOString().slice(0,10)<m.data_as_of)))fail('Invalid manifest dates');
  if(!Array.isArray(m.sources) || !m.sources.length || m.sources.some(s=>!s.id || typeof s.label!=='string' || s.rights_status!=='synthetic') || new Set(m.sources.map(s=>s.id)).size!==m.sources.length)fail('Invalid source registry');
  if(!Array.isArray(m.files))fail('Missing manifest files');
  const entries=new Map();
  for(const f of m.files){safePath(f.path,m.run_id);if(entries.has(f.path)||!['catalog','shard'].includes(f.kind)||!Number.isInteger(f.bytes)||f.bytes<1||f.bytes>2_000_000||!/^[0-9a-f]{64}$/.test(f.sha256)||!Number.isInteger(f.gzip_bytes)||f.gzip_bytes<1||f.gzip_bytes>(f.kind==='catalog'?100000:200000))fail('Invalid manifest file');entries.set(f.path,f);}
  if(entries.get('catalog.json')?.kind!=='catalog' || [...entries.values()].filter(e=>e.kind==='catalog').length!==1)fail('Missing catalog');
  if(embedded&&Object.keys(embedded.files).some(path=>path!=='manifest.json'&&!entries.has(path)))fail('Unexpected bootstrap file');
  const catalog=await read('catalog.json',entries.get('catalog.json'));identity(catalog,m);
  if(embedded&&catalog.models?.length!==1)fail('Bootstrap only supports one synthetic model');
  if(!Array.isArray(catalog.models)||!catalog.models.length)fail('Empty catalog');
  const seen=new Set(), referenced=new Set();
  for(const model of catalog.models){
    if(!model.make||!model.model||seen.has(`${model.make}/${model.model}`))fail('Duplicate/invalid model');seen.add(`${model.make}/${model.model}`);
    safePath(model.shard_path,m.run_id);if(entries.get(model.shard_path)?.kind!=='shard'||referenced.has(model.shard_path))fail('Invalid catalog shard');referenced.add(model.shard_path);
    if(!Array.isArray(model.groups)||!model.groups.length||!Array.isArray(model.supported_modes)||!model.supported_modes.length)fail('Missing groups');
    const ids=new Set();for(const g of model.groups){const c=g.characteristics;if(!g.id||ids.has(g.id)||!c||!Number.isInteger(c.year)||c.year<1900||!Number.isInteger(c.mileage_km)||c.mileage_km<0||['generation','engine','gearbox','drive','region'].some(k=>typeof c[k]!=='string'||!c[k]))fail('Invalid group');ids.add(g.id);}
  }
  if(referenced.size!==[...entries.values()].filter(e=>e.kind==='shard').length)fail('Unreferenced shard');
  const cache=new Map();
  return {manifest:m,catalog,async loadModel(model){
    if(!catalog.models.includes(model))fail('Model not in catalog');
    if(cache.has(model.shard_path))return cache.get(model.shard_path);
    const shard=await read(model.shard_path,entries.get(model.shard_path));
    const normalized=adaptModel(m,model,shard);cache.set(model.shard_path,normalized);return normalized;
  }};
}
