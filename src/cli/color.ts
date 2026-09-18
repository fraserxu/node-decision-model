// ANSI styling with no dependency. Every function is the identity when
// styling is disabled, so callers never branch on it.

export interface Style {
  readonly enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  red(text: string): string;
  cyan(text: string): string;
}

const CODES = {
  bold: [1, 22],
  dim: [2, 22],
  green: [32, 39],
  yellow: [33, 39],
  red: [31, 39],
  cyan: [36, 39],
} as const;

/**
 * Colour is on when stdout is a terminal, off when piped. `--no-color` and a
 * non-empty NO_COLOR turn it off; a non-empty FORCE_COLOR other than "0"
 * turns it on. The flag wins over the environment.
 */
export function colorEnabled(args: {
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
  disabled: boolean;
}): boolean {
  if (args.disabled) return false;
  const noColor = args.env.NO_COLOR;
  if (noColor !== undefined && noColor !== "") return false;
  const force = args.env.FORCE_COLOR;
  if (force !== undefined && force !== "" && force !== "0") return true;
  return args.isTTY;
}

export function createStyle(enabled: boolean): Style {
  const wrap = (name: keyof typeof CODES) => {
    const [open, close] = CODES[name];
    return (text: string) => (enabled && text !== "" ? `[${open}m${text}[${close}m` : text);
  };
  return {
    enabled,
    bold: wrap("bold"),
    dim: wrap("dim"),
    green: wrap("green"),
    yellow: wrap("yellow"),
    red: wrap("red"),
    cyan: wrap("cyan"),
  };
}

export const PLAIN: Style = createStyle(false);
