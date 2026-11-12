#!/usr/bin/env node
'use strict';
// CJS on purpose: the package is "type": "module", so the bin stub must be .cjs
// for `require` to exist. It loads the bundled CLI (tsup -> dist/cli.cjs).
require('../dist/cli.cjs');
