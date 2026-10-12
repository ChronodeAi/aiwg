import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JevCredentialError } from './adapters/jev.js';

export interface JevCredentialRecord {
  token: string;
  region: string;
  endpoint?: string;
  enabled?: boolean;
}

export interface JevCredentialLookupResult {
  source: 'env' | 'file';
  token: string;
  region: string;
  endpoint?: string;
  enabled: boolean;
}

export interface JevCredentialOptions {
  env?: NodeJS.ProcessEnv;
  configHome?: string;
  homeDir?: string;
  credentialPath?: string;
}

export const JEV_CREDENTIAL_REF = 'typesafe-api';
export const JEV_DEFAULT_REGION = 'us';

function env(options: JevCredentialOptions): NodeJS.ProcessEnv {
  return options.env ?? process.env;
}

export function jevCredentialPath(options: JevCredentialOptions = {}): string {
  if (options.credentialPath) return options.credentialPath;
  const configuredHome = options.configHome ?? env(options).XDG_CONFIG_HOME;
  const base = configuredHome && configuredHome.trim() ? configuredHome : path.join(options.homeDir ?? os.homedir(), '.config');
  return path.join(base, 'aiwg', 'credentials', 'jev.json');
}

function isInsecureMode(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

function parseRecord(raw: string): JevCredentialRecord {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new JevCredentialError('configuration');
  const record = parsed as Record<string, unknown>;
  if (typeof record.token !== 'string' || !record.token.trim()) throw new JevCredentialError('configuration');
  if (record.region !== undefined && (typeof record.region !== 'string' || !record.region.trim())) {
    throw new JevCredentialError('configuration');
  }
  if (record.endpoint !== undefined && (typeof record.endpoint !== 'string' || !record.endpoint.trim())) {
    throw new JevCredentialError('configuration');
  }
  if (record.enabled !== undefined && typeof record.enabled !== 'boolean') throw new JevCredentialError('configuration');
  return {
    token: record.token,
    region: typeof record.region === 'string' ? record.region : JEV_DEFAULT_REGION,
    ...(typeof record.endpoint === 'string' ? { endpoint: record.endpoint } : {}),
    ...(typeof record.enabled === 'boolean' ? { enabled: record.enabled } : {}),
  };
}

async function readCredentialFile(options: JevCredentialOptions = {}): Promise<JevCredentialRecord | null> {
  const credentialPath = jevCredentialPath(options);
  try {
    const [fileStat, parentStat] = await Promise.all([stat(credentialPath), stat(path.dirname(credentialPath))]);
    if (isInsecureMode(fileStat.mode) || isInsecureMode(parentStat.mode)) throw new JevCredentialError('denied');
    return parseRecord(await readFile(credentialPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof JevCredentialError) throw error;
    if (error instanceof SyntaxError) throw new JevCredentialError('configuration');
    throw error;
  }
}

export async function lookupJevCredential(options: JevCredentialOptions = {}): Promise<JevCredentialLookupResult | null> {
  const environment = env(options);
  const forced = environment.AIWG_DECISION_ENABLED;
  const envToken = environment.JEV_API_KEY?.trim() || environment.AIWG_DECISION_JEV_API_KEY?.trim();
  const fileRecord = envToken && (forced === '0' || forced === '1') ? null : await readCredentialFile(options);
  const enabled = forced === '0' ? false : forced === '1' ? true : fileRecord?.enabled === true;
  if (envToken) return {
    source: 'env',
    token: envToken,
    region: environment.AIWG_DECISION_JEV_REGION?.trim() || fileRecord?.region || JEV_DEFAULT_REGION,
    ...(environment.AIWG_DECISION_JEV_ENDPOINT?.trim() ? { endpoint: environment.AIWG_DECISION_JEV_ENDPOINT.trim() }
      : fileRecord?.endpoint ? { endpoint: fileRecord.endpoint } : {}),
    enabled,
  };
  if (!fileRecord) return null;
  return { source: 'file', token: fileRecord.token, region: fileRecord.region, ...(fileRecord.endpoint ? { endpoint: fileRecord.endpoint } : {}), enabled };
}

export async function resolveJevCredentialBytes(logicalRef: string, options: JevCredentialOptions = {}): Promise<Uint8Array> {
  if (logicalRef !== JEV_CREDENTIAL_REF) throw new JevCredentialError('configuration');
  const credential = await lookupJevCredential(options);
  if (!credential?.enabled) throw new JevCredentialError('denied');
  if (!credential.token) throw new JevCredentialError('missing');
  return new TextEncoder().encode(credential.token);
}

export async function writeJevCredentialFile(record: JevCredentialRecord, options: JevCredentialOptions = {}): Promise<string> {
  const credentialPath = jevCredentialPath(options);
  const directory = path.dirname(credentialPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const tmp = path.join(directory, `.jev.${process.pid}.${randomUUID()}.tmp`);
  const body = `${JSON.stringify(record, null, 2)}\n`;
  try {
    await writeFile(tmp, body, { mode: 0o600, flag: 'wx' });
    await chmod(tmp, 0o600);
    await rename(tmp, credentialPath);
    await chmod(credentialPath, 0o600);
    return credentialPath;
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeJevCredentialFile(options: JevCredentialOptions = {}): Promise<boolean> {
  const credentialPath = jevCredentialPath(options);
  try {
    await access(credentialPath, constants.F_OK);
  } catch {
    return false;
  }
  await rm(credentialPath, { force: true });
  return true;
}
