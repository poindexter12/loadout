'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tmpFixture(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

module.exports = { tmpFixture };
