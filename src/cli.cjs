'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathsFor, request } = require('./common.cjs');
const { ensureRuntime } = require('./runtime.cjs');

const CONFIG = { sourceRoot: path.resolve(__dirname, '..') };
async function main() {
  const [operation, storageRoot, id, decision] = process.argv.slice(2);
  if (!storageRoot || !path.isAbsolute(storageRoot)) throw new Error('Usage: node src/cli.cjs start|list|health|end|recover|shutdown ABSOLUTE_STORAGE [ID] [--discard|--confirm]');
  let locations = pathsFor(storageRoot);
  if (operation === 'start') {
    const config = process.env.NATIVE_LYX_SETTINGS;
    const settings = config ? JSON.parse(fs.readFileSync(config, 'utf8')) : {};
    locations = await ensureRuntime({ ...CONFIG, storageRoot, settings });
    console.log(JSON.stringify(await request(locations.socket, '/health'), null, 2));
    return;
  }
  const routes = { list: '/sessions', health: '/health', shutdown: '/shutdown', end: '/end', recover: '/recover' };
  if (!routes[operation]) throw new Error('Unknown control operation.');
  if (operation === 'end' && decision !== '--discard') throw new Error('Ending a session requires --discard after resolving native unsaved work.');
  if (operation === 'recover' && decision !== '--confirm') throw new Error('Recovery requires --confirm; all old profiles are preserved.');
  const result = await request(locations.socket, routes[operation], { id, discardConfirmed: decision === '--discard', confirmed: decision === '--confirm' });
  if (operation === 'recover') { delete result.token; delete result.port; }
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
