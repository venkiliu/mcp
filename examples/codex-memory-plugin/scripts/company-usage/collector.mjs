// Collect model usage counters from this OS user's Codex rollouts.
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const digest = s => createHash('sha256').update(s).digest('hex');
const zero = () => [0, 0, 0];
const add = (a, b) => a.map((n, i) => n + b[i]);
const goodCount = n => Number.isSafeInteger(n) && n >= 0;
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});
function dayOf(stamp) {
  const time = Date.parse(stamp);
  if (!Number.isFinite(time)) return null;
  const parts = Object.fromEntries(dayFormatter.formatToParts(time).map(p => [p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function counts(usage) {
  const value = [usage?.input_tokens, usage?.cached_input_tokens, usage?.output_tokens];
  return value.every(goodCount) && value[1] <= value[0] ? value : null;
}
function modelName(value) {
  return typeof value === 'string' && /^[\w./:@+\-]{1,128}$/.test(value) ? value : 'unknown';
}
function newFile() {
  return {session:null, parent:null, turn:'', models:{}, model:'unknown',
    events:{}, legacy:{}, modernTurns:{}, previous:null, offset:0, skipped:0};
}
function tokenPayload(event) {
  const p = event?.payload;
  if (!p || typeof p !== 'object') return null;
  if (event.type === 'token_usage_record' || (event.type === 'event_msg' && p.type === 'token_usage_record')) return 'record';
  if (event.type === 'event_msg' && p.type === 'token_count') return 'legacy';
  return null;
}
export function processEvent(file, e) {
  const p = e.payload || {};
  if (e.type === 'session_meta') {
    // Forks can repeat their parent's session_meta after their own header.
    if (!file.session && (p.id || p.session_id)) {
      file.session = String(p.id || p.session_id);
      file.parent = p.forked_from_id || p.parent_thread_id || null;
      file.model = modelName(p.model);
    }
    return;
  }
  if (e.type === 'turn_context') {
    file.turn = String(p.turn_id || '');
    file.model = modelName(p.model);
    if (file.turn) file.models[digest(file.turn)] = file.model;
    return;
  }
  const kind = tokenPayload(e);
  if (!kind || !file.session) return;
  const day = dayOf(e.timestamp);
  if (!day) { file.skipped++; return; }
  const turn = String(p.turn_id || file.turn);
  const turnKey = digest(turn);
  const model = modelName(p.model ?? file.models[turnKey] ?? file.model);
  if (kind === 'record') {
    if (p.thread_id && p.thread_id !== file.session) return;
    const value = counts(p.usage);
    if (!value) { file.skipped++; return; }
    const key = digest(p.response_id || JSON.stringify([file.session,turn,e.timestamp,p.thread_token_usage,value]));
    file.events[key] = {day,model,value};
    file.modernTurns[turnKey] = true;
    return;
  }
  const total = counts(p.info?.total_token_usage);
  if (!total) return; // rate-limit-only events carry no usage
  let value = total;
  if (file.previous) {
    value = total.map((n,i) => n - file.previous[i]);
    if (value.every(n => n===0)) return;
    if (!value.every(goodCount) || value[1] > value[0]) value = counts(p.info?.last_token_usage);
  } else {
    // A compacted or resumed file can begin with a nonzero historical
    // baseline. Attribute only its first observed response to today's row.
    value = counts(p.info?.last_token_usage) || (file.parent ? null : total);
  }
  file.previous = total;
  if (!value) { file.skipped++; return; }
  // Older clients without unique response IDs: use the counter transition as
  // its identity. Copying a rollout to archived_sessions cannot multiply it.
  const key = digest(JSON.stringify([turn, total, e.timestamp]));
  file.legacy[key] = {day,model,turnKey,value};
}
export function reduceRows(files) {
  const sessions = new Map();
  for (const file of files) {
    if (!file.session) continue;
    if (!sessions.has(file.session)) sessions.set(file.session,{parent:file.parent,events:{},legacy:{},modernTurns:{},models:{}});
    const s = sessions.get(file.session);
    for (const field of ['events','legacy','modernTurns','models']) Object.assign(s[field],file[field]);
  }
  const rows = [];
  for (const [session,s] of sessions) {
    const grouped = new Map();
    function include({day,model,value}) {
      const key = JSON.stringify([day,model]);
      grouped.set(key,add(grouped.get(key) || zero(),value));
    }
    for (const event of Object.values(s.events)) include(event);
    for (const event of Object.values(s.legacy)) {
      if (s.modernTurns[event.turnKey]) continue; // paired compatibility event
      if (s.parent) {
        const parent = sessions.get(s.parent);
        // With no known parent/turn, a replayed historical event cannot be
        // distinguished from this child's usage. Do not count it twice.
        if (!parent || event.turnKey === digest('') || parent.models[event.turnKey]) continue;
      }
      include(event);
    }
    for (const [group, [input_tokens,cached_tokens,output_tokens]] of grouped) {
      const [day,model] = JSON.parse(group);
      rows.push({session_key:digest(session),day,model,input_tokens,cached_tokens,output_tokens});
    }
  }
  return rows;
}

async function* logs(dir) {
  let entries;
  try { entries = await fs.readdir(dir,{withFileTypes:true}); }
  catch (err) { if (err.code === 'ENOENT') return; throw err; }
  for (const entry of entries) {
    const p = path.join(dir,entry.name);
    if (entry.isDirectory()) yield* logs(p);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield p;
  }
}
async function boundary(handle,offset) {
  const len = Math.min(offset,256);
  const bytes = Buffer.alloc(len);
  const result = await handle.read(bytes,0,len,offset-len);
  return digest(bytes.subarray(0,result.bytesRead));
}
async function scanFile(p, saved) {
  const handle = await fs.open(p,'r');
  try {
    const stat = await handle.stat();
    const id = `${stat.dev}-${stat.ino}`;
    if (saved && saved.id === id && stat.size === saved.size && stat.mtimeMs === saved.mtime) return saved;
    let file = saved;
    if (!file || file.id !== id || stat.size < file.offset ||
        (file.size === stat.size && file.mtime !== stat.mtimeMs) ||
        await boundary(handle,file.offset) !== file.boundary) file = newFile();
    if (stat.size > file.offset) {
      const stream = handle.createReadStream({start:file.offset,end:stat.size-1,autoClose:false,highWaterMark:256*1024});
      let remainder = [];
      for await (const chunk of stream) {
        let start=0;
        for (let end; (end=chunk.indexOf(10,start)) !== -1; start=end+1) {
          remainder.push(chunk.subarray(start,end));
          const line = remainder.length===1 ? remainder[0] : Buffer.concat(remainder);
          remainder=[];
          file.offset += line.length+1;
          if (line.includes('"token_count"') || line.includes('"token_usage_record"') ||
              line.includes('"turn_context"') || line.includes('"session_meta"')) {
            try { processEvent(file,JSON.parse(line)); }
            catch { file.skipped++; }
          }
        }
        if (start<chunk.length) remainder.push(chunk.subarray(start));
      }
      // The writer may still be appending the last JSON line. Resume from its start.
    }
    file.boundary = await boundary(handle,file.offset);
    file.size=stat.size;file.mtime=stat.mtimeMs;file.id=id;
    return file;
  } finally { await handle.close(); }
}

async function savePrivate(p,data) {
  const tmp = p+'.'+randomUUID()+'.tmp';
  try { await fs.writeFile(tmp,JSON.stringify(data),{mode:0o600,flag:'wx'}); await fs.rename(tmp,p); }
  finally { await fs.rm(tmp,{force:true}); }
}
function args() {
  const get = (arg, fallback) => {
    const i=process.argv.indexOf(arg);
    if (i<0) return fallback;
    if (!process.argv[i+1] || process.argv[i+1].startsWith('--')) throw Error('Missing '+arg+' value');
    return process.argv[i+1];
  };
  const ov=path.join(os.homedir(),'.openviking');
  return {cfg:get('--config',process.env.OPENVIKING_CLI_CONFIG_FILE||path.join(ov,'ovcli.conf')),
    codex:get('--codex-home',process.env.CODEX_HOME||path.join(os.homedir(),'.codex')),
    state:get('--state-dir',path.join(ov,'codex-usage')), dry:process.argv.includes('--dry-run'),
    full:process.argv.includes('--full')};
}
async function lock(dir) {
  const file=path.join(dir,'collector.lock');
  try { await fs.writeFile(file,String(process.pid),{flag:'wx',mode:0o600}); }
  catch (e) {
    if (e.code!=='EEXIST') throw e;
    const pid=Number(await fs.readFile(file,'utf8'));
    if (!Number.isSafeInteger(pid) || pid<1) throw Error('Another collector is starting');
    try { process.kill(pid,0); }
    catch (err) {
      if (err.code==='ESRCH') { await fs.unlink(file);return lock(dir); }
      throw err;
    }
    throw Error('Another collection is running');
  }
  return () => fs.unlink(file);
}
export async function collect(opts, sender) {
  await fs.mkdir(opts.state,{recursive:true,mode:0o700});
  const release=await lock(opts.state);
  try {
    const cachePath=path.join(opts.state,'cache-v1.json');
    let cache={files:{},reported:{}};
    try {cache=JSON.parse(await fs.readFile(cachePath,'utf8'));} catch(e) {if(e.code!=='ENOENT') throw e;}
    for (const folder of ['sessions','archived_sessions']) {
      for await (const p of logs(path.join(opts.codex,folder))) {
        const k=digest(path.resolve(p));
        const previous = cache.files[k];
        try {
          const updated = await scanFile(p, previous);
          if (previous && previous !== updated) {
            // Rotated, rewritten or truncated logs still represent actual
            // historical use. Preserve known events, then dedup in reduceRows.
            const revision = digest(JSON.stringify([k,previous.id,previous.offset,previous.boundary,previous.session]));
            cache.files[revision] = previous;
            delete cache.files[k];
          }
          cache.files[k] = updated;
        } catch(e) { if (e.code !== 'ENOENT') throw e; }
      }
    }
    const rows=reduceRows(Object.values(cache.files));
    const totals=rows.reduce((a,r)=>add(a,[r.input_tokens,r.cached_tokens,r.output_tokens]),zero());
    const stats={sessions:new Set(rows.map(r=>r.session_key)).size,rows:rows.length,
      input_tokens:totals[0],cached_tokens:totals[1],output_tokens:totals[2],
      incomplete_records:Object.values(cache.files).reduce((n,f)=>n+f.skipped,0)};
    if (opts.dry) return stats;
    const cfg=JSON.parse((await fs.readFile(opts.cfg,'utf8')).replace(/^\uFEFF/,''));
    if (!cfg.url || !cfg.api_key) throw Error('Employee configuration requires url and api_key');
    const target=digest(JSON.stringify([cfg.url,cfg.api_key]));
    const old=cache.reported[target]||{};
    const key=r=>JSON.stringify([r.session_key,r.day,r.model]);
    const next=Object.fromEntries(rows.map(r=>[key(r),[r.input_tokens,r.cached_tokens,r.output_tokens]]));
    const changed=rows.filter(r=>opts.full || JSON.stringify(next[key(r)])!==JSON.stringify(old[key(r)]));
    for(const k of Object.keys(old)) if(!Object.hasOwn(next,k)){
      const [session_key,day,model]=JSON.parse(k);
      changed.push({session_key,day,model,input_tokens:0,cached_tokens:0,output_tokens:0});
    }
    await savePrivate(cachePath,cache);
    const postUsage = sender || (await import('./transport.mjs')).postUsage;
    if (!changed.length) await postUsage(cfg.url,cfg.api_key,[]);
    for(let i=0;i<changed.length;i+=500) await postUsage(cfg.url,cfg.api_key,changed.slice(i,i+500));
    cache.reported[target]=next;
    await savePrivate(cachePath,cache);
    return {...stats,uploaded_rows:changed.length};
  } finally {await release();}
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  collect(args()).then(stats=>console.log(JSON.stringify(stats))).catch(e=>{console.error('Codex 用量采集失败',e.message);process.exitCode=1;});
}
