import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const appRoot = path.resolve(process.cwd());

// Load .env first, then .env.local (the latter wins). No secrets are logged.
dotenv.config({ path: path.join(appRoot, '.env'), quiet: true });
dotenv.config({ path: path.join(appRoot, '.env.local'), override: true, quiet: true });

export const APP_ROOT = appRoot;
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(appRoot, 'data');
export const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
export const PORT = Number(process.env.PORT ?? 8787);
export const HOST = process.env.HOST ?? '127.0.0.1';

export function ensureDataDir(): string {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  return DATA_DIR;
}
