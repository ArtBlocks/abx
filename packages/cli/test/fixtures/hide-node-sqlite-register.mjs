/**
 * Test preload: reproduce an old Node inside a modern one.
 *
 * Registers the loader that makes `node:sqlite` unresolvable, and — when ABX_TEST_FAKE_NODE is
 * set — spoofs `process.versions.node` so the shim's message is exercised for a specific release
 * (e.g. the reporter's 22.5.1). Both live here rather than in production code: bin.ts must not
 * grow a test-only branch, and spoofing from outside proves the real code path.
 */
import {register} from 'node:module';

register('./hide-node-sqlite.mjs', import.meta.url);

const fake = process.env.ABX_TEST_FAKE_NODE;
if (fake) Object.defineProperty(process.versions, 'node', {value: fake, configurable: true});
