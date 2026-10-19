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
  // Logs and LaTeX build artifacts never belong in an Overleaf project: a shell redirect
  // (`overleap sync > sync.log`) or a local pdflatex run inside the sync dir would
  // otherwise upload them. Overleaf regenerates its own on every compile.
  /\.(log|aux|out|fls|fdb_latexmk|synctex\.gz|synctex|xdv|blg|bcf|run\.xml|toc|lof|lot|nav|snm|vrb)$/,
];

module.exports = { IGNORE_PATTERNS };
