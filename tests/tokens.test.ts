import { expect, test } from "bun:test";
import { estimateTokens, formatTokens } from "../lib/tokens";

test("token sizes shorten to at most four characters", () => {
	expect(formatTokens(842)).toBe("842");
	expect(formatTokens(1000)).toBe("1k");
	expect(formatTokens(1234)).toBe("1.2k");
	expect(formatTokens(9999)).toBe("10k");
	expect(formatTokens(12_400)).toBe("12k");
	expect(formatTokens(2_500_000)).toBe("2.5m");
});

test("the estimate is four characters to a token, rounded up", () => {
	expect(estimateTokens("")).toBe(0);
	expect(estimateTokens("abcde")).toBe(2);
});
