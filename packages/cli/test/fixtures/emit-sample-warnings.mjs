/**
 * Test preload: emit the Node 22 SQLite ExperimentalWarning, in both call forms, plus warnings that
 * must still print, once bin.ts has installed its filter. CI runs Node 24, which no longer prints the
 * SQLite warning, so the test supplies it itself instead of depending on the runner's Node version.
 *
 * The preload runs before bin.ts is evaluated. Rather than poll, trap the assignment: when bin.ts
 * replaces process.emitWarning, emit on the next turn. A build without the filter never assigns, so
 * nothing is emitted and the "still prints" assertions fail instead of the test hanging.
 */
let current = process.emitWarning;
Object.defineProperty(process, 'emitWarning', {
  configurable: true,
  enumerable: true,
  get: () => current,
  set(fn) {
    current = fn;
    setImmediate(emit);
  },
});

function emit() {
  process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
  process.emitWarning('SQLite is an experimental feature (abx-test options form)', {type: 'ExperimentalWarning'});
  process.emitWarning('abx-test unrelated experimental feature', 'ExperimentalWarning');
  process.emitWarning('abx-test unrelated options warning', {type: 'DeprecationWarning', code: 'ABX_TEST_CODE'});
  // An Error's name is its type; Node ignores the type argument here, so this is a plain Error warning.
  process.emitWarning(new Error('SQLite is an experimental feature (abx-test plain Error)'), 'ExperimentalWarning');
}
