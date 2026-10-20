#!/usr/bin/env node
'use strict';

const { parseArgs, HELP } = require('../lib/args');
const { greet } = require('../lib/commands');

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
process.stdout.write(greet(options) + '\n');
