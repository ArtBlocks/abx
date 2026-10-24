/**
 * Test preload: emit the Node 22 SQLite ExperimentalWarning and one unrelated ExperimentalWarning
 * after bin.ts has run its synchronous prologue. CI runs Node 24, which no longer prints the SQLite
 * warning, so the test supplies it itself instead of depending on the runner's Node version.
 */
setImmediate(() => {
  process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
  process.emitWarning('abx-test unrelated experimental feature', 'ExperimentalWarning');
});
