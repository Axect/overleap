'use strict';

const fs = require('fs');
const path = require('path');

function loadEnv(dir) {
  const envPath = path.join(dir, '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function getConfig(opts = {}) {
  // Load .env from CWD and from project dir if specified
  loadEnv(process.cwd());
  if (opts.dir) loadEnv(opts.dir);

  const cookie = opts.cookie || process.env.OVERLEAF_COOKIE;
  const url = opts.url || process.env.OVERLEAF_URL || 'https://www.overleaf.com';
  const projectId = opts.project || process.env.OVERLEAF_PROJECT_ID;
  const dir = opts.dir || process.env.OVERLEAF_DIR || process.cwd();

  if (!cookie) {
    throw new Error(
      'OVERLEAF_COOKIE is required.\n' +
      'Set it via --cookie flag, OVERLEAF_COOKIE env var, or .env file.\n' +
      'Get it from browser DevTools → Application → Cookies → overleaf.com'
    );
  }

  return { cookie, url, projectId, dir };
}

module.exports = { getConfig, loadEnv };
