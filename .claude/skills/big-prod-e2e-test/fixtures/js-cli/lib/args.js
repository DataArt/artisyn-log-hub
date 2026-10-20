'use strict';

const DEFAULTS = {
  name: 'world',
  help: false,
};

const HELP = [
  'Usage: js-cli [options]',
  '',
  '  --name <value>  Name to greet (default: "world")',
  '  --help          Show this help (default: false)',
  '',
].join('\n');

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--name') {
      i += 1;
      options.name = argv[i] !== undefined ? argv[i] : DEFAULTS.name;
    } else if (arg.startsWith('--name=')) {
      options.name = arg.slice('--name='.length);
    } else if (arg === '--help') {
      options.help = true;
    } else {
      throw new Error('Unknown argument: ' + arg);
    }
  }
  return options;
}

module.exports = { parseArgs, DEFAULTS, HELP };
