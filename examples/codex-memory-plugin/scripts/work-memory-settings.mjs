// An employee's opt-in belongs to their Codex profile and their personal OpenViking connection.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { readJson, save } from './company-usage/trigger.mjs';

const companyOrigins = new Set(['http://km.venkiliu.top:18443', 'http://127.0.0.1:1933', 'http://localhost:1933']);
const settingsName = 'openviking-work-memory.json';

async function settingsFile() {
  const codexProfile = await fs.realpath(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  return path.join(codexProfile, settingsName);
}

function companyOrigin(value) {
  const url = new URL(value);
  if (!companyOrigins.has(url.origin) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw Error('managed-knowledge-base-required');
  }
  return url.origin;
}

export async function workMemoryProfile(cwd = process.cwd(), proxyConfig = null) {
  const connection = loadConfig(cwd);
  const configFile = await fs.realpath(connection.cliConfigPath);
  const personal = await readJson(configFile);
  const origin = companyOrigin(personal.url);
  if (!personal.api_key || connection.apiKey !== personal.api_key ||
      connection.authMode !== 'api_key' || companyOrigin(connection.baseUrl) !== origin ||
      connection.mcpUrl !== origin + '/mcp' || process.env.OPENVIKING_EXTRA_HEADERS?.trim()) {
    throw Error('personal-connection-required');
  }
  const segments = personal.api_key.split('.');
  if (segments.length !== 3 || !segments.every(segment => /^[A-Za-z0-9_-]+$/.test(segment))) {
    throw Error('personal-api-key-required');
  }
  const [account, user] = segments.slice(0, 2).map(segment => Buffer.from(segment, 'base64url').toString('utf8'));
  if (account !== 'team' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(user) ||
      (personal.account && personal.account !== account) || (personal.account_id && personal.account_id !== account) ||
      (personal.user && personal.user !== user) || (personal.user_id && personal.user_id !== user) ||
      (connection.account && connection.account !== account) || (connection.user && connection.user !== user)) {
    throw Error('employee-identity-mismatch');
  }
  // The MCP proxy can outlive a credential change. Compare the connection used for this request.
  if (proxyConfig && (proxyConfig.apiKey !== personal.api_key || proxyConfig.mcpUrl !== origin + '/mcp' ||
      proxyConfig.sendIdentityHeaders !== false || Object.keys(proxyConfig.extraHeaders || {}).length ||
      (proxyConfig.account && proxyConfig.account !== account) || (proxyConfig.user && proxyConfig.user !== user))) {
    throw Error('proxy-identity-mismatch');
  }
  const file = await settingsFile();
  return createHash('sha256').update(JSON.stringify([file, configFile, origin, account, user, personal.api_key])).digest('hex');
}

export async function workMemoryStatus(cwd = process.cwd(), proxyConfig = null) {
  const saved = await readJson(await settingsFile());
  if (!saved) return {enabled: false, reason: 'not-enabled'};
  const current = await workMemoryProfile(cwd, proxyConfig).catch(() => null);
  if (!current || saved.version !== 1 || saved.profile !== current) return {enabled: false, reason: 'connection-changed'};
  return {enabled: true};
}

export async function workMemoryEnabled(cwd = process.cwd(), proxyConfig = null) {
  // A missing profile, changed credential, or damaged settings file must never enable writing.
  try { return (await workMemoryStatus(cwd, proxyConfig)).enabled; }
  catch { return false; }
}

export async function enableWorkMemory(cwd = process.cwd(), expectedProfile = null) {
  const current = await workMemoryProfile(cwd);
  if (expectedProfile !== null && current !== expectedProfile) throw Error('connection-changed');
  const file = await settingsFile();
  const saved = await readJson(file);
  if (saved?.version !== 1 || saved.profile !== current) await save(file, {version: 1, profile: current});
  return {enabled: true};
}

async function cli() {
  const [option, ...extra] = process.argv.slice(2);
  if (extra.length || !['--enable', '--disable', '--status'].includes(option)) {
    throw Error('usage');
  }
  if (option === '--disable') {
    await fs.rm(await settingsFile(), {force: true});
    return {enabled: false};
  }
  return option === '--enable' ? enableWorkMemory() : workMemoryStatus();
}

if (process.argv[1] && import.meta.url === pathToFileURL(await fs.realpath(process.argv[1]).catch(() => path.resolve(process.argv[1]))).href) {
  try { console.log(JSON.stringify(await cli())); }
  catch (error) {
    console.error(error.message === 'usage'
      ? '用法：node work-memory-settings.mjs --enable | --disable | --status'
      : '工作记忆设置失败，请检查当前 Codex 配置和个人知识库连接。');
    process.exitCode = 1;
  }
}
