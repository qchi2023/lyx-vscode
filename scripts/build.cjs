'use strict';
// SPDX-License-Identifier: MPL-2.0
const path = require('node:path');
const esbuild = require('esbuild');

const CONFIG = { root: path.resolve(__dirname, '..') };
esbuild.build({ absWorkingDir: CONFIG.root, entryPoints: ['media/viewer.js'],
  outfile: 'dist/viewer.js', bundle: true, format: 'esm', legalComments: 'external',
  banner: { js: '/* Native LyX — MPL-2.0. Preferred source: media/viewer.js and vendor/novnc/ included in this package. See LICENSE and THIRD_PARTY_NOTICES.md. */' } })
  .catch(error => { console.error(error.message); process.exitCode = 1; });
