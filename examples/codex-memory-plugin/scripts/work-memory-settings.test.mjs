import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { enableWorkMemory, workMemoryEnabled, workMemoryStatus } from './work-memory-settings.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('separate personal consent survives same-identity use, not endpoint/identity changes', async t => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'ov-work-consent-'));
  const file = path.join(fixture, 'ovcli.conf');
  const profile = path.join(fixture, 'codex');
  await fs.mkdir(profile);
  const origin = 'http://km.venkiliu.top:18443';
  const personalKey = user => ['team', user, 'synthetic-fixture'].map(s => Buffer.from(s).toString('base64url')).join('.');
  const original = {url: origin, api_key: personalKey('tester'), plugin:{codex:{auth_mode:'api_key'}}};
  const writeConfig = value => fs.writeFile(file, JSON.stringify(value));
  const envNames = Object.keys(process.env).filter(k => k.startsWith('OPENVIKING_')).concat(['CODEX_HOME', 'OPENVIKING_CLI_CONFIG_FILE', 'OPENVIKING_CONFIG_FILE']);
  const saved = {...process.env};
  const restore = k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; };
  for (const k of envNames) delete process.env[k];
  t.after(async () => { for (const k of envNames) restore(k); await fs.rm(fixture,{recursive:true,force:true}); });
  process.env.CODEX_HOME = profile;
  process.env.OPENVIKING_CLI_CONFIG_FILE = file;
  process.env.OPENVIKING_CONFIG_FILE = path.join(fixture,'missing.conf');
  const proxy = {apiKey: original.api_key, mcpUrl: origin+'/mcp',sendIdentityHeaders:false,extraHeaders:{}};
  await writeConfig(original);
  assert.equal(await workMemoryEnabled(fixture),false);
  assert.deepEqual(await enableWorkMemory(fixture),{enabled:true});
  assert.equal(await workMemoryEnabled(fixture,proxy),true);
  assert.equal(await workMemoryEnabled(fixture,{...proxy,mcpUrl:'https://example.org/mcp'}),false);
  assert.equal(await workMemoryEnabled(fixture,{...proxy,apiKey:personalKey('someone-else')}),false);
  assert.equal(await workMemoryEnabled(fixture,{...proxy,extraHeaders:{'X-Api-Key':'example'}}),false);
  assert.equal(await workMemoryEnabled(fixture,{...proxy,sendIdentityHeaders:true}),false);
  const stored = await fs.readFile(path.join(profile, 'openviking-work-memory.json'),'utf8');
  assert.ok(!stored.includes(original.api_key) && !stored.includes('tester'));
  for (const patch of [{url:'https://example.org'}, {api_key:''}, {api_key:'root-placeholder'}]) {
    await writeConfig({...original, ...patch});
    assert.equal(await workMemoryEnabled(fixture),false);
    await assert.rejects(enableWorkMemory(fixture));
  }
  await writeConfig({...original, api_key:personalKey('another')});
  assert.equal(await workMemoryEnabled(fixture),false);
  await writeConfig(original);
  process.env.OPENVIKING_MCP_URL = 'https://example.org/mcp';
  try { assert.equal(await workMemoryEnabled(fixture),false); } finally { restore('OPENVIKING_MCP_URL'); }
  assert.deepEqual(await workMemoryStatus(fixture),{enabled:true});
  const command = fileURLToPath(new URL('./work-memory-settings.mjs', import.meta.url));
  const unset = spawnSync(process.execPath,[command,'--disable'],{cwd:fixture,encoding:'utf8'});
  assert.equal(unset.status,0,unset.stderr);
  assert.equal(await workMemoryEnabled(fixture,proxy),false);
});
