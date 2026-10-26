/**
 * Test preload: emit the Node 22 SQLite ExperimentalWarning plus two warnings that must still print,
 * once bin.ts has installed its filter. CI runs Node 24, which no longer prints the SQLite warning,
 * so the test supplies it itself instead of depending on the runner's Node version.
 *
 * The preload runs before bin.ts is evaluated, so wait (one event-loop turn at a time) until
 * process.emitWarning has been replaced. Give up after a bounded number of turns and emit anyway, so
 * a build without the filter fails the assertions instead of hanging.
 */
const original = process.emitWarning;
let turns = 0;
function emit() {
  if (process.emitWarning === original && ++turns < 2000) return void setImmediate(emit);
  process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
  process.emitWarning('abx-test unrelated experimental feature', 'ExperimentalWarning');
  // An Error's name is its type; Node ignores the type argument here, so this is a plain Error warning.
  process.emitWarning(new Error('SQLite is an experimental feature (abx-test plain Error)'), 'ExperimentalWarning');
}
setImmediate(emit);
