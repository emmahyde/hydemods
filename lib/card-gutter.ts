import { grey } from "./colors";
import { estimateTokens, formatTokens } from "./tokens";

export interface GutterInput {
	/** Row prefix before any trailing treatment: the name and rule on the first row, the hanging indent after. */
	prefix: string;
	rule: string;
	trailingRule: string;
	/** Visible width of the name column, which the token count takes over on later rows. */
	indentWidth: number;
	isFirst: boolean;
	isLast: boolean;
	/** Size estimate to show when rows are hidden; absent when nothing is. */
	hiddenText?: string;
}

/**
 * The last row of a card trails off into a dashed rule. When rows are hidden, a later row's name
 * column carries the estimated token size in grey; a first row keeps the tool name, so the caller
 * appends the size to the row instead (see `rowSuffix`).
 */
export function cardGutter(input: GutterInput): string {
	if (!input.isLast) return input.prefix;
	if (input.hiddenText && !input.isFirst) return `${grey(input.hiddenText.padEnd(input.indentWidth))}${input.trailingRule} `;
	return input.prefix.replace(input.rule, input.trailingRule);
}

/** A one-row card has no gutter to spare, so its hidden-size estimate trails the row. */
export function rowSuffix(isFirst: boolean, isLast: boolean, hiddenText: string | undefined): string {
	return isFirst && isLast && hiddenText ? ` ${grey(hiddenText)}` : "";
}

export function hiddenSize(text: string): string {
	return formatTokens(estimateTokens(text));
}
