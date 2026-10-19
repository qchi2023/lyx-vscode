'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { CONFIG: PROTOCOL, pathsFor, privateDirectory, atomicJson, request, delay, isOwned, stopOwned } = require('./common.cjs');
const { inspect } = require('./diagnostics.cjs');

const CONFIG = { engineFiles: ['broker.cjs', 'common.cjs', 'native-ipc.cjs', 'native-launch.cjs'], startTimeoutMs: 15000 };

function stageEngine(sourceRoot, storageRoot) {
  const contents = CONFIG.engineFiles.map(filename => [filename, fs.readFileSync(path.join(sourceRoot, 'src', filename))]);
  const hash = crypto.createHash('sha256');
  for (const [filename, bytes] of contents) hash.update(filename).update(bytes);
  const version = hash.digest('hex').slice(0, 24);
  const location = privateDirectory(path.join(pathsFor(storageRoot).engines, version));
  for (const [filename, bytes] of contents) {
    const target = path.join(location, filename);
    if (fs.existsSync(target)) {
      if (!fs.readFileSync(target).equals(bytes)) throw new Error('Immutable broker source was modified. Preserve active sessions and inspect runtime storage.');
    } else {
      try { fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST' || !fs.readFileSync(target).equals(bytes)) throw error; }
    }
  }
  return location;
}

async function ensureRuntime({ sourceRoot, storageRoot, settings = {} }) {
  const locations = pathsFor(storageRoot);
  privateDirectory(locations.storage);
  privateDirectory(locations.runtime);
  const engine = stageEngine(sourceRoot, storageRoot);
  try {
    const health = await request(locations.socket, '/health', {}, 1500);
    if (health.protocol !== PROTOCOL.protocol) throw new Error('An incompatible runtime is retaining sessions. Save/resolve its native sessions before upgrading its protocol.');
    if (health.engine === engine) return locations;
    // A compatible broker can finish its current native decision/startup. The
    // client checks for an engine update again after the quit is resolved.
    if (health.pending && health.capabilities?.includes('graceful-quit')) return locations;
    const saved = JSON.parse(fs.readFileSync(locations.lock, 'utf8'));
    const relative = path.relative(locations.engines, health.engine || '');
    if (!isOwned(health) || saved.pid !== health.pid || saved.start !== health.start || saved.boot !== health.boot ||
        relative.startsWith('..') || path.isAbsolute(relative) || !relative) {
      throw new Error('Cannot verify ownership of the previous broker. Its native sessions were left intact.');
    }
    const sessions = await request(locations.socket, '/sessions');
    if (health.pending || sessions.some(session => session.state === 'starting')) {
      throw new Error('Wait for Native LyX startup to finish before updating its connection broker.');
    }
    // Upgrade the connection broker only. Every native application/desktop has
    // a separate owned process group; the new broker adopts their registry.
    stopOwned(health, 'SIGTERM');
    const deadline = Date.now() + 5000;
    while (isOwned(health) && Date.now() < deadline) await delay(50);
    if (isOwned(health)) throw new Error('The previous broker has not exited; native sessions were preserved.');
  } catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
  }
  const diagnostic = inspect(settings);
  if (!diagnostic.ok) throw new Error(`${diagnostic.errors.join('\n')}\nSee the extension's installation guide or Native LyX: Check Dependencies.`);
  atomicJson(locations.config, { ...diagnostic.resolved, storageRoot: locations.storage });
  const log = fs.openSync(path.join(locations.storage, 'broker.log'), 'a', 0o600);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(diagnostic.resolved.nodePath, [path.join(engine, 'broker.cjs'), locations.config],
    { cwd: locations.storage, detached: true, stdio: ['ignore', log, log], env });
  fs.closeSync(log);
  let failure;
  child.on('error', error => { failure = error; });
  child.unref();
  const deadline = Date.now() + CONFIG.startTimeoutMs;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    try {
      const health = await request(locations.socket, '/health', {}, 1000);
      if (health.protocol !== PROTOCOL.protocol) throw new Error('Retained runtime protocol mismatch.');
      return locations;
    } catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
    await delay(100);
  }
  throw new Error(`Native runtime did not answer. Retained sessions were not stopped. Inspect ${path.join(locations.storage, 'broker.log')}.`);
}
module.exports = { CONFIG, stageEngine, ensureRuntime };
