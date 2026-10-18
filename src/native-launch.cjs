'use strict';
const { spawn } = require('node:child_process');
const { identity, atomicJson } = require('./common.cjs');

const CONFIG = { receipt: process.argv[2], executable: process.argv[3], args: process.argv.slice(4) };
const owner = identity(process.pid);
const child = spawn(CONFIG.executable, CONFIG.args, { stdio: 'inherit' });
child.on('error', error => {
  atomicJson(CONFIG.receipt, { owner, code: null, signal: null, error: error.message, at: new Date().toISOString() });
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  atomicJson(CONFIG.receipt, { owner, code, signal, at: new Date().toISOString() });
  process.exitCode = code === 0 ? 0 : 1;
});
