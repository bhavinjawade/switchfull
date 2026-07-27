export const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  inverse: "\x1b[7m",
  // Semantic foregrounds. Fixed 256-color values keep the UI readable across
  // terminals whose basic ANSI palette is unusually muted or low contrast.
  black: "\x1b[38;5;232m",
  red: "\x1b[38;5;203m",
  green: "\x1b[38;5;114m",
  yellow: "\x1b[38;5;221m",
  blue: "\x1b[38;5;117m",
  magenta: "\x1b[38;5;213m",
  cyan: "\x1b[38;5;51m",
  white: "\x1b[38;5;255m",
  gray: "\x1b[38;5;250m",
  // Keep dim text legible: gray foreground is preferable to ANSI faint here.
  dim: "\x1b[38;5;244m",
  bgBlack: "\x1b[48;5;232m",
  bgBlue: "\x1b[48;5;25m",
  bgMagenta: "\x1b[48;5;53m",
  bgCyan: "\x1b[48;5;24m",
  bgGray: "\x1b[48;5;239m",
  // Charcoal surfaces create hierarchy without leaving the terminal aesthetic.
  bgPanel: "\x1b[48;5;232m",
  bgPanelAlt: "\x1b[48;5;235m",
  bgHeader: "\x1b[48;5;233m",
  // Indigo selection is intentionally much more distinct than the old gray.
  bgSelected: "\x1b[48;5;25m",
  clear: "\x1b[2J",
  home: "\x1b[H",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  altOn: "\x1b[?1049h",
  altOff: "\x1b[?1049l",
};

export function color(text: string, ...codes: string[]): string {
  if (process.env["NO_COLOR"]) return text;
  return `${codes.join("")}${text}${ansi.reset}`;
}

export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  if (plain.length <= width) return text;
  if (width <= 1) return "…";
  // Best-effort truncate ignoring ANSI for layout simplicity
  return `${plain.slice(0, width - 1)}…`;
}

export function pad(text: string, width: number, align: "left" | "right" = "left"): string {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  if (plain.length >= width) return truncate(text, width);
  const padding = " ".repeat(width - plain.length);
  return align === "left" ? `${text}${padding}` : `${padding}${text}`;
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [""];
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word.slice(0, width);
      continue;
    }
    if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word.slice(0, width);
    }
  }
  if (current) lines.push(current);
  return lines;
}
