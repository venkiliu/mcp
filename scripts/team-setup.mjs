// Team-maintained, explicit opt-in migration. Run in the employee's Codex environment.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';

const teamId = 'openviking-memory@venki-team';
const officialId = 'openviking-memory@openviking';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const codexRoot = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const configFile = path.join(codexRoot, 'config.toml');
const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const args = process.argv.slice(2);
const sourceIndex = args.indexOf('--source');
const source = sourceIndex >= 0 ? args[sourceIndex + 1] : '';
const confirmUsage = args.includes('--confirm-usage');
const confirmWorkMemory = args.includes('--confirm-work-memory');
const allowed = ['--confirm-work-memory', '--confirm-usage'];
if (sourceIndex >= 0) allowed.push('--source', source);
const usage = '用法：node scripts/team-setup.mjs --confirm-work-memory 和/或 --confirm-usage [--source <公司 Git 地址>]';

function atomicWrite(file, value) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, value, {mode: 0o600, flag:'wx'});
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, {force:true}); }
}

function codex(parts) {
  // Windows npm shims need cmd.exe. Arguments passed to it are rejected if shell metacharacters occur.
  let exe='codex', command=['plugin', ...parts];
  if (process.platform === 'win32') {
    if (command.some(arg => /[&|<>^%!\r\n"]/.test(arg))) throw Error('命令参数包含 Windows shell 不支持的字符。');
    exe='cmd.exe'; command=['/d','/s','/c',['codex',...command].map(arg=>'"'+arg+'"').join(' ')];
  }
  const result=spawnSync(exe,command,{encoding:'utf8',timeout:90000,windowsHide:true,maxBuffer:8*1024*1024});
  if (result.status!==0) throw Error('Codex 插件操作失败：'+parts.slice(0,2).join(' ')+'。请确认 Codex CLI 可运行且公司插件源可访问。');
  return result.stdout;
}
const listing = () => JSON.parse(codex(['list','--json'])).installed || [];

// Find true TOML table headings while skipping quoted strings and comments, including multiline strings.
function tables(text) {
  const starts=[];
  let quote=null, escaped=false;
  const lines=text.match(/.*(?:\r?\n|$)/g).filter(Boolean);
  let offset=0;
  for (const line of lines) {
    if (!quote && /^\s*\[/.test(line)) starts.push({start:offset, header:line.trim().replace(/\s+#.*$/,'')});
    for (let i=0;i<line.length;i++) {
      const c=line[i];
      if (quote) {
        if (escaped) { escaped=false; continue; }
        if (quote[0]==='"' && c==='\\') { escaped=true; continue; }
        if (line.slice(i,i+quote.length)===quote) { i+=quote.length-1; quote=null; }
      } else {
        if (c==='#') break;
        if (c==='"' || c==="'") {
          quote=line.slice(i,i+3)===c.repeat(3)?c.repeat(3):c;
          i+=quote.length-1;
        }
      }
    }
    offset+=line.length;
  }
  if (quote) throw Error('Codex 配置含未结束的字符串。');
  return starts.map((t,index)=>({...t,end:starts[index+1]?.start ?? text.length}));
}
function keyState(text,id) {
  const choices=['[plugins."'+id+'"]',"[plugins.'"+id+"']"];
  const found=tables(text).filter(t=>choices.includes(t.header));
  if (found.length>1) throw Error('插件配置节重复，保留现有配置。');
  if (!found.length) {
    // Inline/dotted plugin settings require a TOML-aware manual migration.
    if (text.includes(id)) throw Error('当前插件配置使用非常规 TOML 写法，请由 Codex 按原格式迁移。');
    return {section:null, enabled:null};
  }
  const section=found[0], body=text.slice(section.start,section.end);
  const enabled=[...body.matchAll(/^([ \t]*enabled[ \t]*=[ \t]*)(true|false)([ \t]*(?:#.*)?\r?)$/gm)];
  if (enabled.length>1 || (!enabled.length && /^\s*["']?enabled["']?\s*=/m.test(body)))
    throw Error('插件 enabled 配置无法可靠修改，保留现有配置。');
  return {section,enabled:enabled.length ? enabled[0][2]==='true' : null};
}
function setEnabled(text,id,value) {
  const {section}=keyState(text,id);
  if (!section) return text.trimEnd()+'\n\n[plugins."'+id+'"]\nenabled = '+value+'\n';
  const body=text.slice(section.start,section.end);
  const changed=/^[ \t]*enabled[ \t]*=/m.test(body)
    ? body.replace(/^([ \t]*enabled[ \t]*=[ \t]*)(true|false)/m,'$1'+value)
    : body.includes('\n') ? body.replace(/\n/,'\nenabled = '+value+'\n') : body+'\nenabled = '+value+'\n';
  return text.slice(0,section.start)+changed+text.slice(section.end);
}

async function main() {
  if ((!confirmUsage && !confirmWorkMemory) || args.some(a=>!allowed.includes(a)) || (sourceIndex>=0 && !source))
    throw Error(usage+'。须取得员工对所选功能的明确同意。');
  if (source && !/^(https?:\/\/|ssh:\/\/|[^\s/@]+@[^\s/:]+:)/.test(source))
    throw Error('--source 只接受公司 Git URL。已有本地源请先在 Codex 登记，再省略 --source。');
  if (Number(process.versions.node.split('.')[0])<18) throw Error('需要 Node.js 18 或更新版本。');
  const sourceTrigger=path.join(root,'examples/codex-memory-plugin/scripts/company-usage/trigger.mjs');
  const sourceApi=await import(pathToFileURL(sourceTrigger).href);
  const context=confirmUsage ? await sourceApi.context() : null;
  const settingsModule='scripts/work-memory-settings.mjs';
  let memoryProfile;
  if (confirmWorkMemory) {
    const sourceSettings=await import(pathToFileURL(path.join(root,'examples','codex-memory-plugin',settingsModule)).href);
    memoryProfile=await sourceSettings.workMemoryProfile();
  }
  const before=read(configFile);
  keyState(before,teamId); keyState(before,officialId);
  const backupDir=path.join(os.homedir(),'.openviking',confirmUsage ? 'codex-usage' : 'work-memory','setup-backups');
  fs.mkdirSync(backupDir,{recursive:true,mode:0o700});
  const backup=path.join(backupDir,new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID()+'.toml');
  fs.writeFileSync(backup,before,{mode:0o600,flag:'wx'});
  let expected=before, enrolled=null, enrolledBytes=null, priorEnrollment=context ? read(context.enrollment) : null;
  let changed=false;
  try {
    if (read(configFile)!==expected) throw Error('配置同时发生变化，请稍后重试。');
    if (source) {
      changed=true;
      try { codex(['marketplace','add',source,'--ref','main']); }
      finally { expected=read(configFile); }
    }
    const markets=JSON.parse(codex(['marketplace','list','--json'])).marketplaces || [];
    if (!markets.some(m=>m.name==='venki-team')) throw Error('尚未添加公司插件源。请提供已发布的 --source 地址。');
    function installTeam() {
      changed=true;
      let installed;
      try { installed=JSON.parse(codex(['add',teamId,'--json'])); }
      finally { expected=read(configFile); }
      if (installed.pluginId!==teamId || !installed.installedPath) throw Error('安装结果与团队插件不匹配。');
      const installedRoot=fs.realpathSync(installed.installedPath);
      const cache=fs.realpathSync(path.join(codexRoot,'plugins','cache','venki-team','openviking-memory'));
      if (!installedRoot.startsWith(cache+path.sep)) throw Error('团队插件安装位置异常。');
      return {installed,installedRoot};
    }
    let {installed,installedRoot}=installTeam();
    if (confirmWorkMemory && !fs.existsSync(path.join(installedRoot,settingsModule))) {
      // Adding an existing Git marketplace reuses its cached snapshot. Pull before enabling this new feature.
      try { codex(['marketplace','upgrade','venki-team']); }
      finally { expected=read(configFile); }
      ({installed,installedRoot}=installTeam());
      if (!fs.existsSync(path.join(installedRoot,settingsModule))) throw Error('公司插件源当前版本尚不支持工作记忆。');
    }
    const trigger=await import(pathToFileURL(path.join(installedRoot,'scripts/company-usage/trigger.mjs')).href);
    if (confirmUsage) {
      const installedContext=await trigger.context();
      if (installedContext.profile!==context.profile) throw Error('切换期间个人 OpenViking 身份发生变化。');
      if (read(configFile)!==expected) throw Error('配置同时发生变化，请稍后重试。');
      enrolled=await trigger.command('--enroll');
      enrolledBytes=read(context.enrollment);
      if (!enrolled?.enrolled) throw Error('用量登记未成功。');
    }
    const next=setEnabled(setEnabled(expected,teamId,true),officialId,false);
    if (read(configFile)!==expected) throw Error('配置同时发生变化，请稍后重试。');
    atomicWrite(configFile,next); expected=next;
    const rows=listing();
    if (!rows.some(r=>r.pluginId===teamId && r.installed && r.enabled) ||
        rows.some(r=>r.pluginId===officialId && r.enabled))
      throw Error('当前工作区的配置覆盖了插件切换，请由 Codex 检查项目级插件设置。');
    const summary={installed:true,plugin:teamId,version:installed.version,officialEnabled:false,configBackup:backup};
    if (confirmUsage) {
      const status=await trigger.command('--probe');
      summary.enrolled=status.enrolled;
      summary.lastRun=status.lastRun;
    }
    if (confirmWorkMemory) {
      const settingsPath=path.join(installedRoot,settingsModule);
      const settings=await import(pathToFileURL(settingsPath).href);
      summary.workMemory=await settings.enableWorkMemory(process.cwd(),memoryProfile);
    }
    console.log(JSON.stringify(summary,null,2));
    console.log('团队插件已启用。请完全退出并重开 Codex，按提示审阅并允许团队 hooks，然后完成一次日常会话。');
  } catch(error) {
    let rollbackError;
    try {
    if (changed) {
      const latest=read(configFile);
      let repaired=latest;
      for (const id of [teamId,officialId]) {
        const original=keyState(before,id);
        const current=keyState(repaired,id);
        // A concurrent user choice takes precedence over our rollback.
        if (current.enabled!==keyState(expected,id).enabled)
          throw Error('插件开关在切换期间被另外修改。请检查插件状态，原配置备份：'+backup);
        if (original.enabled!==null) repaired=setEnabled(repaired,id,original.enabled);
        else if (current.section) {
          const {start,end}=current.section;
          let body=repaired.slice(start,end).replace(/^[ \t]*enabled[ \t]*=[^\n]*(?:\n|$)/m,'');
          if (!original.section && !body.slice(body.indexOf('\n')+1).trim()) body='';
          repaired=repaired.slice(0,start)+body+repaired.slice(end);
        }
      }
      if (read(configFile)!==latest) throw Error('配置正在被其他程序修改，请检查插件状态，原配置备份：'+backup);
      atomicWrite(configFile,repaired);
    }
    } catch(failure) { rollbackError=failure; }
    if (enrolled && read(context.enrollment)===enrolledBytes && enrolledBytes!==priorEnrollment) {
      if (priorEnrollment) atomicWrite(context.enrollment,priorEnrollment);
      else fs.rmSync(context.enrollment,{force:true});
    }
    throw rollbackError || error;
  }
}

fs.mkdirSync(codexRoot,{recursive:true,mode:0o700});
const lock=path.join(codexRoot,'.venki-team-setup.lock');
let handle;
try {
  handle=fs.openSync(lock,'wx',0o600);
  fs.writeFileSync(handle,String(process.pid));
  await main();
} catch(error) {
  if (error.code==='EEXIST') {
    const pid=Number(read(lock));
    let active=false;
    if (Number.isSafeInteger(pid) && pid>0) {
      try { process.kill(pid,0); active=true; } catch(e) { active=e.code==='EPERM'; }
    }
    console.error(active ? '另一份团队配置切换正在运行，请等待它完成。' :
      '上一次配置切换已停止。请让 Codex 检查当前插件开关，并删除残留锁后重试：'+lock);
  } else console.error(error.message);
  process.exitCode=1;
} finally {
  if (handle!==undefined) {fs.closeSync(handle); fs.rmSync(lock,{force:true});}
}
