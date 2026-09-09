// `abx mint-page` generates a page that reads maxInvocations/paused (or, for an edition, the per-id
// totalSupply/maxSupply) and mints through a shared fixed-price minter — none of which a plain 1/1
// (OneOfOneImage) has (no minter lane at all). Before this guard, pointing mint-page at a 1/1 wrote
// a page that built and ran fine, then sat on "Loading…" forever with no diagnostic.
// `assertMintableSeries` is the refusal `cmdMintPage` calls with the result of `detectTokenKind`
// (kind.ts) against the target contract — every kind EXCEPT `1of1` composes a minter lane.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertMintableSeries} from '../src/commands/scaffold.js';
import {CliError} from '../src/errors.js';
import type {TokenKindInfo} from '../src/kind.js';

const TOKEN = '0x00000000000000000000000000000000000bad';

const KIND_1OF1: TokenKindInfo = {kind: '1of1', isEdition: false, label: 'OneOfOneImage'};
const KIND_SERIES: TokenKindInfo = {kind: 'series', isEdition: false, label: 'SeriesImage'};
const KIND_CODE: TokenKindInfo = {kind: 'code', isEdition: false, label: 'SeriesCode'};
const KIND_1OF1_EDITION: TokenKindInfo = {kind: '1of1-edition', isEdition: true, label: 'OneOfOneEdition'};
const KIND_EDITION: TokenKindInfo = {kind: 'edition', isEdition: true, label: 'EditionImage'};
const KIND_EDITION_CODE: TokenKindInfo = {kind: 'edition-code', isEdition: true, label: 'EditionCode'};

test('assertMintableSeries: refuses a plain 1/1 (OneOfOneImage — no minter lane at all)', () => {
  assert.throws(
    () => assertMintableSeries(TOKEN, KIND_1OF1),
    (err: unknown) => {
      assert.ok(err instanceof CliError, 'must throw the CLI\'s typed error, not a bare Error');
      assert.match((err as Error).message, /looks like a 1\/1/);
      assert.match((err as Error).message, /minter lane/);
      // the pointed fixes — a Series, or an edition of one work
      assert.match((err as Error).message, /abx deploy-series --dir <folder> --count 1/);
      assert.match((err as Error).message, /abx deploy --copies/);
      assert.match((err as Error).message, new RegExp(TOKEN));
      return true;
    },
  );
});

test('assertMintableSeries: passes a Series / SeriesCode target (both compose a minter lane)', () => {
  assert.doesNotThrow(() => assertMintableSeries(TOKEN, KIND_SERIES));
  assert.doesNotThrow(() => assertMintableSeries(TOKEN, KIND_CODE));
});

test('assertMintableSeries: passes every edition kind — OneOfOneEdition/EditionImage/EditionCode all ship the sale stack', () => {
  assert.doesNotThrow(() => assertMintableSeries(TOKEN, KIND_1OF1_EDITION));
  assert.doesNotThrow(() => assertMintableSeries(TOKEN, KIND_EDITION));
  assert.doesNotThrow(() => assertMintableSeries(TOKEN, KIND_EDITION_CODE));
});

test('assertMintableSeries: does NOT refuse when the probe itself could not run (RPC unreachable → undefined)', () => {
  // Scaffolding offline (or against an address the RPC can't reach) must degrade to "continue, with
  // a warning" — never a hard refusal, the same tolerance the collectionName name() read already has.
  assert.doesNotThrow(() => assertMintableSeries(TOKEN, undefined));
});
