'use strict';

const IGNORE_PATTERNS = [
  /(^|[/\\])\../,  // dotfiles
  /node_modules/,
  /\.git/,
  /\.env(\.|$)/,   // .env, .env.local, .env.production
  /~$/,             // editor backup files
  /\.swp$/,
  /\.swo$/,
  /\.tmp\.\d+$/,    // our own atomic write temp files
];

module.exports = { IGNORE_PATTERNS };
