// A rough size for tool output: about four characters per token. The host exposes no tokenizer,
// so this is an estimate, which is all a card gutter needs.

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** `842`, `1.2k`, `12k`, `1.3m`: short enough for a gutter. */
export function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	if (tokens < 10_000) return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
	return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
