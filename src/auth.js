'use strict';

const https = require('https');
const http = require('http');
const cheerio = require('cheerio');

function httpGet(url, cookie) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const httpModule = parsed.protocol === 'http:' ? http : https;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'Cookie': cookie,
        'User-Agent': 'overleap/0.1',
        'Accept': 'text/html,application/xhtml+xml',
      },
    };

    const req = httpModule.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('Request timeout'));
    });
    req.end();
  });
}

async function fetchProjectPage(cookie, baseUrl) {
  const res = await httpGet(baseUrl + '/project', cookie);

  if (res.status === 302) {
    throw new Error('Cookie expired or invalid (redirected to login)');
  }

  if (res.status !== 200) {
    throw new Error(`Unexpected status: ${res.status}`);
  }

  const $ = cheerio.load(res.body);

  const csrfToken = $('meta[name="ol-csrfToken"]').attr('content');
  const userId = $('meta[name="ol-user_id"]').attr('content');
  const userEmail = $('meta[name="ol-usersEmail"]').attr('content') || '';

  if (!csrfToken || !userId) {
    throw new Error('Failed to extract CSRF token or user ID from /project page');
  }

  // Extract project list from prefetched blob
  let projects = [];
  const prefetchedBlob = $('meta[name="ol-prefetchedProjectsBlob"]').attr('content');
  if (prefetchedBlob) {
    try {
      const parsed = JSON.parse(prefetchedBlob);
      projects = (parsed.projects || parsed || []).map((p) => ({
        id: p._id || p.id,
        name: p.name,
        lastUpdated: p.lastUpdated,
        accessLevel: p.accessLevel || p.privileges || 'unknown',
      }));
    } catch (e) {
      // Ignore parse errors
    }
  }

  // Fallback: try ol-projects meta tag
  if (projects.length === 0) {
    const projectsMeta = $('meta[name="ol-projects"]').attr('content');
    if (projectsMeta) {
      try {
        const parsed = JSON.parse(projectsMeta);
        projects = parsed.map((p) => ({
          id: p._id || p.id,
          name: p.name,
          lastUpdated: p.lastUpdated,
          accessLevel: p.accessLevel || 'unknown',
        }));
      } catch (e) {
        // Ignore parse errors
      }
    }
  }

  return { csrfToken, userId, userEmail, projects };
}

/**
 * Fetch /socket.io/socket.io.js to get GCLB (load balancer) cookie.
 * Required for session stickiness during Socket.IO handshake.
 */
async function updateCookies(cookie, baseUrl) {
  const res = await httpGet(baseUrl + '/socket.io/socket.io.js', cookie);

  // M5: parse existing cookies into a Map to prevent duplicate appending
  const cookieMap = new Map();
  for (const part of cookie.split(';')) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      cookieMap.set(trimmed.slice(0, eqIdx), trimmed.slice(eqIdx + 1));
    }
  }

  const setCookie = res.headers['set-cookie'];
  if (setCookie) {
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const c of cookies) {
      const nameValue = c.split(';')[0].trim();
      const eqIdx = nameValue.indexOf('=');
      if (eqIdx > 0) {
        cookieMap.set(nameValue.slice(0, eqIdx), nameValue.slice(eqIdx + 1));
      }
    }
  }

  return Array.from(cookieMap.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function httpPost(url, cookie, csrfToken, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const httpModule = parsed.protocol === 'http:' ? http : https;
    const data = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Cookie': cookie,
        'X-Csrf-Token': csrfToken,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'overleap/0.1',
        'Accept': 'application/json',
      },
    };

    const req = httpModule.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: responseBody });
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error('Request timeout'));
    });
    req.write(data);
    req.end();
  });
}

function httpDelete(url, cookie, csrfToken) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const httpModule = parsed.protocol === 'http:' ? http : https;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: parsed.pathname + parsed.search,
      method: 'DELETE',
      headers: {
        'Cookie': cookie,
        'X-Csrf-Token': csrfToken,
        'User-Agent': 'overleap/0.1',
        'Accept': 'application/json',
      },
    };

    const req = httpModule.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('Request timeout'));
    });
    req.end();
  });
}

function httpGetBinary(url, cookie) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const httpModule = parsed.protocol === 'http:' ? http : https;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'Cookie': cookie,
        'User-Agent': 'overleap/0.1',
      },
    };

    const req = httpModule.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => { chunks.push(chunk); });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy(new Error('Download timeout'));
    });
    req.end();
  });
}

module.exports = { fetchProjectPage, updateCookies, httpGet, httpPost, httpGetBinary };
