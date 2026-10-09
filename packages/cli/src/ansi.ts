/** ANSI styling for human-facing CLI output.
 *
 * stdout is the CLI's primary narration stream. When it is piped, every helper must become a
 * no-op even if stderr is still attached to a terminal; otherwise escape bytes leak into agent and
 * shell pipelines. `NO_COLOR` disables styling in interactive use too.
 */
export function ansiEnabled(isTTY: boolean | undefined, noColor: string | undefined): boolean {
  return !noColor && isTTY === true;
}

const enabled = ansiEnabled(process.stdout.isTTY, process.env.NO_COLOR);

const code = (value: string): string => (enabled ? value : '');

export const ANSI = {
  reset: code('\x1b[0m'),
  dim: code('\x1b[2m'),
  bold: code('\x1b[1m'),
  green: code('\x1b[38;5;115m'),
  purple: code('\x1b[38;5;141m'),
  orange: code('\x1b[38;5;215m'),
  yellow: code('\x1b[38;5;221m'),
  red: code('\x1b[31m'),
};

export const ansiDim = (value: string): string => `${ANSI.dim}${value}${ANSI.reset}`;
export const ansiBold = (value: string): string => `${ANSI.bold}${value}${ANSI.reset}`;
export const ansiGreen = (value: string): string => `${ANSI.green}${value}${ANSI.reset}`;
export const ansiPurple = (value: string): string => `${ANSI.purple}${value}${ANSI.reset}`;
export const ansiYellow = (value: string): string => `${ANSI.yellow}${value}${ANSI.reset}`;
export const ansiRed = (value: string): string => `${ANSI.red}${value}${ANSI.reset}`;
