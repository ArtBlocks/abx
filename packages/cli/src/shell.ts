/**
 * POSIX single-quote escaping for a value that will be pasted into a shell.
 * A token of letters, digits, and a small set of punctuation is left as-is;
 * anything else becomes one quoted argument (`'` inside the value → `'\''`).
 */
export function shArg(v: string): string {
  return /^[A-Za-z0-9,._+:@%/=-]+$/.test(v) ? v : `'${v.replace(/'/g, "'\\''")}'`;
}
