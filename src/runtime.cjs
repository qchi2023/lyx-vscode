'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { CONFIG: PROTOCOL, pathsFor, privateDirectory, atomicJson, request, delay } = require('./common.cjs');
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
  try {
    const health = await request(locations.socket, '/health', {}, 1500);
    if (health.protocol !== PROTOCOL.protocol) throw new Error('An incompatible runtime is retaining sessions. Save/resolve its native sessions before upgrading its protocol.');
    return locations;
  } catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
  }
  const diagnostic = inspect(settings);
  if (!diagnostic.ok) throw new Error(`${diagnostic.errors.join('\n')}\nSee the extension's installation guide or Native LyX: Check Dependencies.`);
  const engine = stageEngine(sourceRoot, storageRoot);
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
