// The one success green: the prompt glyph, tool names, passing runs and finished todos all use it.
export const SUCCESS_GREEN = [0x9c, 0xdb, 0x75] as const;

export function green(text: string): string {
	const [r, g, b] = SUCCESS_GREEN;
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}
