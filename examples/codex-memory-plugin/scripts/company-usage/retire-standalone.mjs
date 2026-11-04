// Migrate our older per-user scheduler only after the plugin's real report succeeds.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import path from 'node:path';

function run(program, args, extraEnv = {}) {
  return spawnSync(program, args, {
    encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...process.env, ...extraEnv },
  });
}

export function matchesStandaloneProfile(base, runner, configPath, codexHome) {
  try {
    const file = realpathSync(runner);
    const parent = path.dirname(file);
    if (path.basename(file) !== 'run-usage.mjs' ||
        !/^[0-9a-f]{24}$/.test(path.basename(parent)) ||
        path.dirname(parent) !== realpathSync(path.join(base, 'versions'))) return false;
    const saved = JSON.parse(readFileSync(path.join(parent, 'settings.json'), 'utf8'));
    return realpathSync(saved.config) === realpathSync(configPath) &&
      realpathSync(saved.codexHome) === realpathSync(codexHome);
  } catch { return false; }
}

function retireMac(base, configPath, codexHome) {
  const label = 'com.venki.openviking.codex-usage';
  const plist = path.join(homedir(), 'Library', 'LaunchAgents', label + '.plist');
  if (!existsSync(plist)) return 'absent';
  const info = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]);
  if (info.status !== 0) return 'unverified';
  const job = JSON.parse(info.stdout);
  if (job.Label !== label || job.ProgramArguments?.length !== 2 ||
      !matchesStandaloneProfile(base, job.ProgramArguments[1], configPath, codexHome)) return 'different-profile';
  const domain = 'gui/' + process.getuid() + '/' + label;
  const loaded = run('/bin/launchctl', ['print', domain]);
  if (loaded.status === 0) {
    if (/^\s*state = running\s*$/m.test(loaded.stdout)) return 'busy';
    if (!loaded.stdout.includes(job.ProgramArguments[1])) return 'different-profile';
    if (run('/bin/launchctl', ['bootout', domain]).status !== 0) return 'retry';
  }
  renameSync(plist, path.join(base, 'stopped-by-openviking-plugin.plist'));
  return 'retired';
}

const windowsPrelude = `
$ErrorActionPreference='Stop'
$name='OpenViking-Codex-Usage-'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$task=Get-ScheduledTask -TaskPath '\\' -TaskName $name -ErrorAction SilentlyContinue
if (!$task) { exit 3 }
$actions=@($task.Actions)
if ($actions.Count -ne 1 -or $actions[0].Arguments -notmatch '^"([^"]+)"$') { exit 4 }
$runner=$Matches[1]
`;
function retireWindows(base, configPath, codexHome) {
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const query = code => ['-NoProfile','-NonInteractive','-Command',windowsPrelude+code];
  const info = run(ps, query('[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Write-Output $runner'));
  if (info.status === 3) return 'absent';
  if (info.status !== 0) return 'unverified';
  const runner = info.stdout.trim();
  if (!matchesStandaloneProfile(base, runner, configPath, codexHome)) return 'different-profile';
  const remove = run(ps, query(`
if ($runner -ne $env:OV_PREVIOUS_USAGE_RUNNER) { exit 4 }
if ($task.State -eq 'Running') { exit 5 }
Unregister-ScheduledTask -InputObject $task -Confirm:$false
`), {OV_PREVIOUS_USAGE_RUNNER: runner});
  return remove.status === 0 ? 'retired' : 'retry';
}

export function retireStandalone({configPath, codexHome}) {
  const base = path.join(homedir(), '.openviking', 'codex-usage-agent');
  const marker = path.join(base, '.managed-openviking-usage');
  const receipt = path.join(base, 'retired-by-openviking-plugin.json');
  try {
    if (existsSync(receipt)) return 'already-retired';
    if (!existsSync(marker) || readFileSync(marker,'utf8').trim() !== 'OpenViking Codex usage agent') return 'absent';
    const status = platform() === 'darwin' ? retireMac(base,configPath,codexHome) :
      platform() === 'win32' ? retireWindows(base,configPath,codexHome) : 'unsupported';
    if (status === 'retired') writeFileSync(receipt, JSON.stringify({retired_at:new Date().toISOString()})+'\n', {mode:0o600});
    return status;
  } catch { return 'retry'; }
}
