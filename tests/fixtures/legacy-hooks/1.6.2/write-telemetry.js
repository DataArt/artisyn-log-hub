'use strict';
const fs = require('fs');
const path = require('path');

function writeTelemetry(event, telemetryDir) {
  fs.mkdirSync(telemetryDir, {recursive: true});
  const sessionId = event.session_id || 'unknown-session';
  const filepath = path.join(telemetryDir, `${sessionId}.jsonl`);
  fs.appendFileSync(filepath, JSON.stringify(event) + '\n', 'utf8');
}

module.exports = {writeTelemetry};
