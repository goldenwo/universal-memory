// server/test/consent-snapshot.test.mjs — A7 acceptance pin (Stage B task U1 spec).
//
// `esc()` moved out of consent.mjs into server/lib/escape-html.mjs verbatim.
// This test proves the extraction was behaviorally inert: `test/fixtures/
// consent-snapshot.html` was captured from renderConsentPage BEFORE the
// extraction (same fixed, entity-stressing input as below, module-private
// esc() still in consent.mjs). If this test still passes byte-for-byte after
// the repoint, the refactor changed nothing observable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderConsentPage } from '../lib/oauth/consent.mjs';

const FIXED_INPUT = {
  clientName: `Acme & <script>alert("x")</script> 'MCP'`,
  redirectHost: `evil"host'<>&.example.com`,
  authzId: `authz-"123'&<>`,
  csrf: `csrf-'token"&<>xyz`,
  needsToken: true,
  error: `Bad <token> & "quotes" 'here'`,
  providers: [
    { id: `git"hub'&<>`, label: `Git<Hub>&"'` },
    { id: 'plain', label: 'Plain Provider' },
  ],
};

test('A7: consent page render is byte-identical to the pre-extraction snapshot', () => {
  const expected = readFileSync(new URL('./fixtures/consent-snapshot.html', import.meta.url), 'utf8');
  const actual = renderConsentPage(FIXED_INPUT);
  assert.equal(actual, expected);
});
