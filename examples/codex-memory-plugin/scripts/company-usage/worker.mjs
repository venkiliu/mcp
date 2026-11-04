// Short-lived, detached lifecycle worker; no daemon or permanent timer.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {acquire,check,context,enabled,queue,readJson,save} from './trigger.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const timing = {interval:15*60000,settle:1500,retry:60000,maxRetries:3};
const verifiedFinal = new Set(['retired','already-retired','absent']);
async function exists(p) { try {await fs.access(p); return true;} catch(e) {if(e.code==='ENOENT') return false;throw e;} }

async function legacyMatches(ctx) {
  const base = path.join(os.homedir(),'.openviking','codex-usage-agent');
  const marker = path.join(base,'.managed-openviking-usage');
  const oldCache = path.join(ctx.local,'cache-v1.json');
  if (!(await exists(marker)) || !(await exists(oldCache))) return false;
  if ((await fs.readFile(marker,'utf8')).trim() !== 'OpenViking Codex usage agent') return false;
  const versions=await fs.readdir(path.join(base,'versions'),{withFileTypes:true}).catch(()=>[]);
  if (!versions.length) return false;
  // Only reuse an existing machine-wide standalone cursor if ALL known releases
  // had this exact log source & profile and it has reported to precisely this key.
  for(const version of versions) {
    if(!version.isDirectory() || !/^[0-9a-f]{24}$/.test(version.name)) return false;
    const item=await readJson(path.join(base,'versions',version.name,'settings.json'));
    if (!item?.codexHome || !item.config ||
        await fs.realpath(item.codexHome).catch(()=>null)!==ctx.codexHome ||
        await fs.realpath(item.config).catch(()=>null)!==ctx.configPath) return false;
  }
  const cache=await readJson(oldCache);
  const targets=Object.keys(cache?.reported || {});
  return targets.length===1 && targets[0]===ctx.target;
}

async function chooseState(ctx) {
  const own=path.join(ctx.dir,'profiles',ctx.profile);
  await fs.mkdir(own,{recursive:true,mode:0o700});
  if (!(await exists(path.join(own,'cache-v1.json'))) && await legacyMatches(ctx))
    return {state:ctx.local,own};
  return {state:own,own};
}
async function copyRetiredCheckpoint(ctx,state,own) {
  if (state === own || !(await legacyMatches(ctx))) return;
  const tmp=path.join(own,'.cursor-'+randomUUID());
  try {
    await fs.copyFile(path.join(state,'cache-v1.json'),tmp);
    await fs.chmod(tmp,0o600);
    await fs.rename(tmp,path.join(own,'cache-v1.json'));
  } finally { await fs.rm(tmp,{force:true}); }
}

export async function sync(binding) {
  const ctx=await context();
  await check(ctx,binding);
  const {state,own}=await chooseState(ctx);
  const {collect}=await import('./collector.mjs');
  const {postUsage}=await import('./transport.mjs');
  const stats=await collect({cfg:ctx.configPath,codex:ctx.codexHome,state,dry:false,full:false},
    async (url,key,rows) => {
      // A first history scan can take minutes. Re-check the actual values going
      // on the wire, the effective plugin identity, AND the still-live enrollment.
      if(digest([url,key]) !== ctx.target) throw Error('identity-changed');
      const live=await context();
      await check(live,binding);
      return postUsage(url,key,rows);
    });
  return {ctx,state,own,stats};
}

async function sendFromHook(binding) {
  const result=await sync(binding);
  // The probe calls sync() only. Migration requires a successful lifecycle dispatch.
  await check(await context(),binding);
  const {retireStandalone}=await import('./retire-standalone.mjs');
  const migration=await retireStandalone({configPath:result.ctx.configPath,codexHome:result.ctx.codexHome});
  if(verifiedFinal.has(migration))
    await copyRetiredCheckpoint(result.ctx,result.state,result.own);
  return {migration,uploadedRows:result.stats.uploaded_rows};
}

export async function drain(binding,{
  getContext=context, send=sendFromHook, now=Date.now, wait=sleep, times=timing,
}={}) {
  let attempts=0;
  for (;;) {
    const ctx=queue(await getContext(),binding);
    await check(ctx,binding);
    const release=await acquire(ctx.dir);
    if(!release) return;
    let exhausted=false;
    const settleLimit=now()+times.settle;
    try {
      for (;;) {
        await check(await getContext(),binding);
        const pending=await readJson(ctx.pending);
        if(!enabled(pending,binding) || !['SessionStart','Stop'].includes(pending.event) || !pending.ticket) return;
        let status=await readJson(ctx.status,{});
        if (!enabled(status,binding)) status={};
        if (status.processedTicket===pending.ticket) break;
        const t=now();
        // This is a trailing throttle: any number of Stops before the deadline
        // collapse into one scan, including the last Stop if no further hook runs.
        const due=Math.max(status.nextDueAt || 0,
          Math.min(pending.requestedAt + times.settle,settleLimit));
        if (due>t) { await wait(Math.min(due-t,times.interval)); continue; }
        const attempt={...status,profile:binding.profile,registration:binding.registration,lastAttemptAt:t};
        let result;
        try { result=await send(binding); }
        catch {
          attempts++;
          await save(ctx.status,{...attempt,nextDueAt:now()+Math.min(times.retry*2**(attempts-1),times.interval),result:'retry'});
          if(attempts>=times.maxRetries) {exhausted=true;break;}
          continue;
        }
        attempts=0;
        const at=now();
        await save(ctx.status,{...attempt,lastSuccessAt:at,lastHookEvent:pending.event,
          processedTicket:pending.ticket,nextDueAt:at+times.interval,result:'ok',
          uploadedRows:result.uploadedRows,standalone:result.migration});
      }
    } finally { await release(); }
    if(exhausted) return;
    // Close the lost-wakeup race: a hook can enqueue just before we relinquish
    // the lease. After release, either this worker or the next hook handles it.
    const [pending,status]=await Promise.all([readJson(ctx.pending),readJson(ctx.status)]);
    if (!enabled(pending,binding) || (enabled(status,binding) && pending.ticket===status.processedTicket)) return;
  }
}

if(process.argv[1] && import.meta.url===pathToFileURL(await fs.realpath(process.argv[1]).catch(()=>path.resolve(process.argv[1]))).href) {
  try {
    const ctx=await context(), binding=await check(ctx);
    if (binding.registration===process.argv[2]) await drain(binding);
  } catch { /* No stdout, URL, exception text, chat payload, or credentials in hook output. */ }
}
