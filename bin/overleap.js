#!/usr/bin/env node
'use strict';

const { parseArgs } = require('util');
const Daemon = require('../src/daemon');

// Global handlers — prevent credential leakage in stack traces
process.on('unhandledRejection', (err) => {
  console.error('[error]', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('[error]', err.message || String(err));
  process.exit(1);
});

const USAGE = `
overleap — Bidirectional real-time sync with Overleaf

Usage:
  overleap sync     [options]   Connect and start syncing
  overleap projects [options]   List available projects
  overleap compile  [options]   Trigger compilation, download PDF

Options:
  --project, -p <query>   Project ID, number, or name to fuzzy match
  --dir, -d <path>        Local directory (default: cwd)
  --cookie, -c <cookie>   Overleaf session cookie
  --url, -u <url>         Overleaf URL (default: https://www.overleaf.com)
  --help, -h              Show this help

Project selection:
  -p 3                    Pick 3rd project from the list
  -p "quantum"            Fuzzy match by name
  -p 64a1b2c3d4e5...      Direct Overleaf project ID
  (omit -p)               Interactive numbered list

Environment variables (or .env file):
  OVERLEAF_COOKIE         Session cookie
  OVERLEAF_URL            Overleaf server URL
  OVERLEAF_PROJECT_ID     Default project ID

Note: Requires git for installation (socket.io-client is fetched from GitHub).
`;

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: 'string', short: 'p' },
      dir: { type: 'string', short: 'd' },
      cookie: { type: 'string', short: 'c' },
      url: { type: 'string', short: 'u' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    process.exit(0);
  }

  const command = positionals[0];
  const daemon = new Daemon(values);

  switch (command) {
    case 'projects':
      daemon.listProjects()
        .then((projects) => {
          if (projects.length === 0) {
            console.log('No projects found.');
            return;
          }
          console.log(`\nFound ${projects.length} projects:\n`);
          daemon._printProjectList(projects);
          console.log('Use: overleap sync -p <number or name>');
        })
        .catch(fatal);
      break;

    case 'sync':
      daemon.start().catch(fatal);
      break;

    case 'compile':
      daemon.compile().catch(fatal);
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exit(1);
  }
}

function fatal(err) {
  console.error('\n[error]', err.message || err);
  process.exit(1);
}

main();
