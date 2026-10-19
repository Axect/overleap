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

module.exports = { BINDING_FILE, readBinding, assertBinding, writeBinding };
