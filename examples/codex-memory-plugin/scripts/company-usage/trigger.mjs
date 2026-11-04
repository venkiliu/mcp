// Independent lifecycle hook. Only scheduling metadata crosses into the worker.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const local = path.join(os.homedir(), '.openviking', 'codex-usage');
const supported = new Set(['http://127.0.0.1:1933', 'http://localhost:1933', 'http://km.venkiliu.top:18443']);
const worker = fileURLToPath(new URL('./worker.mjs', import.meta.url));
export const enabled = (a,b) => Boolean(a && b && a.profile === b.profile && a.registration === b.registration);

export async function readJson(file, missing = null) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/,'')); }
  catch (e) { if (e.code === 'ENOENT') return missing; throw e; }
}
export async function save(file, value) {
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temp, JSON.stringify(value) + '\n', {mode:0o600, flag:'wx'});
    await fs.rename(temp,file);
  } finally { await fs.rm(temp,{force:true}); }
}
export async function paths() {
  const codexHome = await fs.realpath(path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')));
  const dir = path.join(local, 'plugin-v1', digest(codexHome));
  return {codexHome,dir,local,enrollment:path.join(dir,'enrollment.json')};
}

export function queue(ctx,binding) {
  if (!/^[0-9a-f-]{36}$/.test(binding.registration)) throw Error('invalid-registration');
  const dir=path.join(ctx.dir,'run-'+binding.registration);
  return {...ctx,dir,pending:path.join(dir,'pending.json'),status:path.join(dir,'last-run.json')};
}

function origin(base) {
  const url = new URL(base);
  if (!supported.has(url.origin) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw Error('unsupported-service');
  return url.origin;
}
export async function context(cwd = process.env.OV_COMPANY_USAGE_WORKSPACE || process.cwd()) {
  const {loadConfig} = await import('../config.mjs');
  const effective = loadConfig(cwd);
  if (!effective.cliConfigPath) throw Error('personal-cli-config-required');
  const configPath = await fs.realpath(effective.cliConfigPath);
  const raw = await readJson(configPath);
  const acct = raw?.account || raw?.account_id || '';
  const user = raw?.user || raw?.user_id || '';
  if (!raw?.url || typeof raw.api_key !== 'string' || !raw.api_key.trim() ||
      effective.apiKey !== raw.api_key || origin(raw.url) !== origin(effective.baseUrl) ||
      (effective.account || '') !== acct || (effective.user || '') !== user)
    throw Error('identity-mismatch');
  const p = await paths();
  // Keep credentials in memory only. Bytes of the URL also match the old collector's reported index.
  const target = digest([raw.url,raw.api_key]);
  return {...p,configPath,target,profile:digest([p.codexHome,configPath,target,acct,user])};
}
export async function check(ctx, expected) {
  const identity = await readJson(ctx.enrollment);
  if (!identity || identity.profile !== ctx.profile || !identity.registration ||
      (expected && !enabled(identity,expected))) throw Error('not-enrolled-or-profile-changed');
  return identity;
}
export async function command(mode) {
  if (mode === '--unenroll') {
    const p = await paths();
    await fs.rm(p.enrollment,{force:true});
    return {enrolled:false};
  }
  const ctx = await context();
  if (mode === '--enroll') {
    await fs.mkdir(ctx.dir,{recursive:true,mode:0o700});
    const existing = await readJson(ctx.enrollment);
    // Keep the generation stable on an idempotent reinstall; revoke any older worker on a switch.
    if (!existing || existing.profile !== ctx.profile || !existing.registration)
      await save(ctx.enrollment, {profile:ctx.profile,registration:randomUUID(),enrolledAt:new Date().toISOString()});
    return {enrolled:true};
  }
  const binding = await check(ctx);
  if (mode === '--probe') {
    const status = await readJson(queue(ctx,binding).status);
    return {enrolled:true,lastRun:enabled(status,binding) ? status : null};
  }
  if (mode === '--sync-probe') {
    const {sync} = await import('./worker.mjs');
    const result = await sync(binding);
    return {enrolled:true,uploadedRows:result.stats.uploaded_rows,mode:'probe'};
  }
  throw Error('unknown-option');
}

// A real event is required for worker scheduling. Neither probe path can manufacture
// a hook success or retire an older scheduler. Do not persist transcripts or session IDs.
export async function scheduleUsage(input) {
  if (!['Stop','SessionStart'].includes(input?.hook_event_name) ||
      typeof input.session_id !== 'string' || !input.session_id.trim()) return;
  const cwd = (typeof input.cwd === 'string' && path.isAbsolute(input.cwd)) ? input.cwd : process.cwd();
  const ctx = await context(cwd);
  const {profile,registration} = await check(ctx);
  const q=queue(ctx,{registration});
  await fs.mkdir(q.dir,{recursive:true,mode:0o700});
  await save(q.pending, {profile,registration,ticket:randomUUID(),event:input.hook_event_name,requestedAt:Date.now()});
  if (await active(q.dir)) return;
  const child = spawn(process.execPath,[worker,registration],{
    detached:true,stdio:'ignore',windowsHide:true,cwd:process.cwd(),
    env:{...process.env,CODEX_HOME:ctx.codexHome,OV_COMPANY_USAGE_WORKSPACE:cwd},
  });
  await new Promise((ok,fail) => {child.once('spawn',ok);child.once('error',fail);});
  child.unref();
}

// An atomic nonempty-directory rename publishes the owner PID and nonce together.
// On Unix and Windows it cannot replace another nonempty directory. Reapers
// delete only the exact dead owner's nonce, never another worker's lease.
const lockPath = dir => path.join(dir,'worker.lock');
async function cleanOwner(lock,name) {
  try { await fs.unlink(path.join(lock,name)); } catch(e) { if(e.code !== 'ENOENT') throw e; }
  try { await fs.rmdir(lock); } catch(e) { if (!['ENOENT','ENOTEMPTY','EEXIST','EPERM','EBUSY'].includes(e.code)) throw e; }
}
async function active(dir) {
  const lock = lockPath(dir);
  let names;
  try { names = await fs.readdir(lock); } catch(e) { if(e.code === 'ENOENT') return false; throw e; }
  if (!names.length) return false;
  const [name] = names;
  const pid = Number(/^([1-9]\d*)-[a-f0-9-]+$/.exec(name)?.[1]);
  if (!Number.isSafeInteger(pid)) throw Error('invalid-worker-lock');
  try { process.kill(pid,0); return true; }
  catch(e) {
    if (e.code === 'EPERM') return true;
    if (e.code !== 'ESRCH') throw e;
    await cleanOwner(lock,name);
    return false;
  }
}
export async function acquire(dir) {
  const name = process.pid + '-' + randomUUID();
  const temp = path.join(dir,'.claim-'+name), lock = lockPath(dir);
  await fs.mkdir(temp,{mode:0o700});
  try {
    await fs.writeFile(path.join(temp,name),'',{mode:0o600,flag:'wx'});
    if (await active(dir)) return null;
    // A prior release/reap can leave a transient empty directory (Windows won't replace it).
    try { await fs.rmdir(lock); } catch(e) { if(!['ENOENT','ENOTEMPTY','EEXIST','EPERM','EBUSY'].includes(e.code)) throw e; }
    try { await fs.rename(temp,lock); }
    catch(e) {
      if (['ENOTEMPTY','EEXIST','EPERM','EACCES','EBUSY'].includes(e.code) && await fs.stat(lock).catch(()=>null)) return null;
      throw e;
    }
    return () => cleanOwner(lock,name);
  } finally { await fs.rm(temp,{recursive:true,force:true}); }
}

async function hookInput() {
  if (process.stdin.isTTY) return null;
  let size=0; const parts=[];
  for await (const chunk of process.stdin) {
    size+=chunk.length;
    // Large final assistant messages are possible; ignore overlarge optional payloads.
    if(size>16*1024*1024) return null;
    parts.push(chunk);
  }
  if (!size) return null;
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

async function main() {
  const mode = process.argv[2];
  if (mode) {
    try { console.log(JSON.stringify(await command(mode))); }
    catch { console.error('OpenViking 用量：个人配置、登记状态或上报校验未通过。'); process.exitCode=1; }
  } else {
    try { await scheduleUsage(await hookInput()); } catch { /* Optional observer: fail closed. */ }
    process.stdout.write('{}\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await fs.realpath(process.argv[1]).catch(()=>path.resolve(process.argv[1]))).href) void main();
