'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const CONFIG = {
  executables: { lyxPath: ['lyx'], nodePath: ['node'], vncPath: ['Xtigervnc', 'Xvnc'],
    windowManagerPath: ['openbox'], websockifyPath: ['websockify'], wmctrlPath: ['wmctrl'],
    xauthPath: ['xauth'], dbusPath: ['dbus-run-session'] },
  defaults: { width: 1200, height: 800, dpi: 96, autosaveSeconds: 30, maxSessions: 4, startupTimeoutMs: 60000 },
  ranges: { width: [640, 3840], height: [480, 2160], dpi: [72, 192], autosaveSeconds: [1, 300],
    maxSessions: [1, 12], startupTimeoutMs: [5000, 180000] }
};

function executable(value, names, searchPath = process.env.PATH || '') {
  const candidates = value ? [value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value] : names;
  for (const candidate of candidates) {
    const locations = candidate.includes(path.sep) ? [path.resolve(candidate)] : searchPath.split(path.delimiter).filter(Boolean).map(dir => path.join(dir, candidate));
    for (const location of locations) {
      try {
        fs.accessSync(location, fs.constants.X_OK);
        if (fs.statSync(location).isFile()) return fs.realpathSync(location);
      } catch {}
    }
  }
  return null;
}

function inspect(settings = {}, platform = process.platform, architecture = process.arch) {
  const errors = [];
  if (platform !== 'linux' || architecture !== 'x64') errors.push('This preview supports local Linux x64 desktop VS Code only. Windows, macOS, WSL/SSH remote workspaces and web editors are not supported.');
  const resolved = { dependencyRoot: settings.dependencyRoot ? path.resolve(settings.dependencyRoot) : '' };
  const search = [resolved.dependencyRoot && path.join(resolved.dependencyRoot, 'usr/bin'), process.env.PATH].filter(Boolean).join(path.delimiter);
  for (const [key, names] of Object.entries(CONFIG.executables)) {
    resolved[key] = executable(settings[key], names, search);
    if (!resolved[key]) errors.push(`Missing ${names.join(' / ')}. Install the documented Linux dependency or set nativeLyxRelease.${key}.`);
  }
  for (const [key, fallback] of Object.entries(CONFIG.defaults)) {
    resolved[key] = settings[key] ?? fallback;
    const [minimum, maximum] = CONFIG.ranges[key];
    if (!Number.isInteger(resolved[key]) || resolved[key] < minimum || resolved[key] > maximum) errors.push(`${key} must be an integer between ${minimum} and ${maximum}.`);
  }
  if (resolved.nodePath) {
    const result = spawnSync(resolved.nodePath, ['--version'], { encoding: 'utf8', timeout: 5000 });
    const major = Number(result.stdout?.trim().match(/^v(\d+)/)?.[1]);
    if (result.status !== 0 || major < 18 || !major) errors.push('Standalone Node.js 18 or newer is required. Set nativeLyxRelease.nodePath to its executable.');
  }
  return { ok: errors.length === 0, errors, resolved, platform, architecture };
}

if (require.main === module) {
  const configPath = process.argv[2];
  const settings = configPath ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  const result = inspect(settings);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
module.exports = { CONFIG, executable, inspect };
