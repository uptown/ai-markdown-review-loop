import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

it('renders repeated email-like text within a bounded subprocess budget', () => {
  // The old linkify-it scan required ~7 seconds for this 128 KB fixture on the
  // audit machine. A subprocess deadline also stops a reintroduced blocking loop.
  const probe = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const md = require('markdown-it')({ html: false, linkify: true, typographer: false });
    const rendered = md.render('a@b.com '.repeat(16000));
    assert.equal((rendered.match(/href="mailto:a@b.com"/g) || []).length, 16000);
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 4000 });
  assert.equal(probe.error, undefined, `Linkification exceeded its bounded render budget: ${probe.error?.message}`);
  assert.equal(probe.status, 0, probe.stderr);
});
