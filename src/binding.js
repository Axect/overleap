'use strict';

const fs = require('fs');
const path = require('path');

// Records which Overleaf project a local directory belongs to. Dotfile, so the
// watcher and initial scan never upload it (IGNORE_PATTERNS skips dotfiles).
const BINDING_FILE = '.overleap-project';

function bindingPath(dir) {
  return path.join(dir, BINDING_FILE);
}

/** Return { id, name } recorded for `dir`, or null when the directory is unbound. */
function readBinding(dir) {
  let raw;
  try {
    raw = fs.readFileSync(bindingPath(dir), 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const data = JSON.parse(raw);
  if (!data || typeof data.id !== 'string') {
    throw new Error(`${bindingPath(dir)} is malformed: expected {"id": "...", "name": "..."}`);
  }
  return data;
}

/**
 * Refuse to operate on `projectId` when `dir` is already bound to a different project.
 * Project numbers follow the last-modified order of the project list, so `-p 5` can name a
 * different project after any edit; this check stops that drift from syncing a wrong
 * project into (and uploading this directory's files to) someone else's document.
 */
function assertBinding(dir, projectId) {
  const bound = readBinding(dir);
  if (bound && bound.id !== projectId) {
    throw new Error(
      `${dir} is bound to project "${bound.name}" (${bound.id}), ` +
      `but the selected project is ${projectId}. Refusing to continue.\n` +
      `Select the bound project with -p ${bound.id}, or delete ${bindingPath(dir)} ` +
      'if this directory should follow a different project.'
    );
  }
  return bound;
}

function writeBinding(dir, projectId, name) {
  fs.writeFileSync(bindingPath(dir), JSON.stringify({ id: projectId, name }, null, 2) + '\n');
}

// Held by the `overleap sync` running in a directory. Two daemons on one directory both
// see every local edit and both send it: Overleaf applies the second copy transformed
// over the first (every insert appears twice), and their binary uploads keep replacing
// each other's files. Dotfile, so it is never uploaded.
const LOCK_FILE = '.overleap-lock';

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
  } catch (err) {
    return null; // missing or unreadable: treat as not held
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Claim `dir` for this process. Throws when another live process holds it; a lock left
 * by a process that has exited is taken over. Returns a function releasing the lock.
 */
function acquireDirLock(dir) {
  const lockPath = path.join(dir, LOCK_FILE);
  fs.mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n', { flag: 'wx' });
      return () => {
        const holder = readLock(lockPath);
        if (holder && holder.pid === process.pid) fs.rmSync(lockPath, { force: true });
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const holder = readLock(lockPath);
    if (holder && Number.isInteger(holder.pid) && holder.pid !== process.pid && isAlive(holder.pid)) {
      throw new Error(
        `Another overleap sync (pid ${holder.pid}) is already running in ${dir}. ` +
        'Stop it first: two daemons on one directory send every local edit twice.'
      );
    }
    fs.rmSync(lockPath, { force: true }); // stale: its process has exited
  }
  throw new Error(`Could not acquire ${lockPath}`);
}

module.exports = { BINDING_FILE, LOCK_FILE, readBinding, assertBinding, writeBinding, acquireDirLock };
