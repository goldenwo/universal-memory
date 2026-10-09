// server/test/fixtures/exact-token-population.fixture.mjs — #203 PR 1 (plan T1.3
// substitute). A SYNTHETIC payload scroll for buildPopulation: every string here
// is invented for the test, none is corpus content.
//
// It exercises each IDENTIFIER_RX alternative, the sub-4-char drop, the
// targetability filters (superseded, invalidated, _um_system), the projected-id
// fallback (a point with no payload.id), both strata (length > 400 and the
// `<summary>` prefix), the >1200-char seed truncation, and the identical-set
// collapse in both its longest-wins and equal-length (first-seen) forms.

const LONG_FILLER = 'The widget pipeline notes go on at length here. '.repeat(30);

export const POPULATION_FIXTURE_POINTS = Object.freeze([
  { id: 'p-1', payload: { id: 'doc-alpha', data: 'Turned on FAKE_FLAG_ONE for the widget pipeline in v9.8.7; see lib/widget.mjs and #4321. Also #1111 and #2222.' } },
  { id: 'p-2', payload: { id: 'doc-beta', data: 'The widget pipeline restarts with --dry-run first; FAKE_FLAG_ONE stays off on host-a:8080.' } },
  { id: 'p-3', payload: { data: 'A fact without a payload id mentioning 9.8.7 and do_thing() once.' } },
  { id: 'p-4', payload: { id: 'doc-gamma', data: `${LONG_FILLER} It reads ~/demo/path/file and cites #4321 and #12. ${LONG_FILLER}` } },
  { id: 'p-5', payload: { id: 'doc-super', status: 'superseded', data: 'Old note about FAKE_FLAG_TWO and lib/widget.mjs.' } },
  { id: 'p-6', payload: { id: 'doc-sys', userId: '_um_system', data: 'System doc with FAKE_FLAG_THREE.' } },
  { id: 'p-7', payload: { id: 'doc-inval', invalidated_at: '2026-01-01T00:00:00Z', data: 'Invalidated doc with FAKE_FLAG_FOUR.' } },
  { id: 'p-8', payload: { id: 'doc-delta', data: '<summary>Session summary: v9.8.7 shipped, and so did v1.2.3 (aka 1.2.3).</summary>' } },
  { id: 'p-9', payload: { id: 'doc-eps', status: 'Deprecated', data: 'Deprecated: --dry-run was renamed.' } },
  { id: 'p-10', payload: { id: 'doc-zeta', data: 'Tracked #7001 and #7002 together.' } },
]);
