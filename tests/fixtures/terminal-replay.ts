// Entirely synthetic: preserves only the screenshot's long-answer / adjacent-replies
// shape. No real session, account, credential, path, or user wording is copied.
export const replayMarkers = {
	question: "REPLAY-Q1",
	answerStart: "REPLAY-A1-BEGIN",
	paragraphs: Array.from({ length: 96 }, (_, index) => `REPLAY-P${String(index + 1).padStart(3, "0")}`),
	answerEnd: "REPLAY-A1-END",
	firstReply: "REPLAY-REPLY-A",
	secondQuestion: "REPLAY-QUESTION-2",
	thirdQuestion: "REPLAY-QUESTION-3",
	secondReply: "REPLAY-Q2",
	thirdReply: "REPLAY-Q3",
};

export const orderedReplayMarkers = [
	replayMarkers.question,
	replayMarkers.answerStart,
	...replayMarkers.paragraphs,
	replayMarkers.answerEnd,
	replayMarkers.firstReply,
	replayMarkers.secondQuestion,
	replayMarkers.secondReply,
	replayMarkers.thirdQuestion,
	replayMarkers.thirdReply,
];

export function sanitizedReplaySession(cwd: string): string {
	const timestamp = "2026-01-01T00:00:00.000Z";
	const answer = [
		replayMarkers.answerStart,
		...replayMarkers.paragraphs.map(marker => `${marker}\n\nThe fictional harbor team is reviewing a simple plan for organizing its public reading room. Keep the explanation visible while the terminal becomes narrower and wider. Each paragraph has a short stable marker, followed by deliberately long ordinary prose that wraps differently at different terminal widths. The shelves, windows, and paper labels in this example are invented solely for this offline rendering replay.`),
		replayMarkers.answerEnd,
		`➡️ ${replayMarkers.firstReply} The first answer remains visible.`,
		"---",
		`❓ **${replayMarkers.secondQuestion}** - Should we keep the earlier explanation?`,
		`➡️ ${replayMarkers.secondReply} Yes.`,
		"---",
		`❓ **${replayMarkers.thirdQuestion}** - What should the next step contain?`,
		`➡️ ${replayMarkers.thirdReply} Yes to all three.`,
	].join("\n\n");
	const messages = [
		{ role: "user", content: `${replayMarkers.question}\nPlease explain the fictional reading-room plan.`, timestamp: Date.parse(timestamp) },
		{
			role: "assistant",
			content: [{ type: "text", text: answer }],
			api: "openai-responses", provider: "openai", model: "gpt-5",
			usage: {
				input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop", timestamp: Date.parse(timestamp) + 1,
		},
	];
	return [
		{ type: "session", version: 3, id: "00000000-0000-4000-8000-000000000001", timestamp, cwd, title: "Synthetic terminal replay" },
		{ type: "model_change", id: "model-0", parentId: null, timestamp, model: "openai/gpt-5", role: "default" },
		...messages.map((message, index) => ({
			type: "message", id: `message-${index}`, parentId: index === 0 ? "model-0" : `message-${index - 1}`, timestamp, message,
		})),
	].map(entry => JSON.stringify(entry)).join("\n") + "\n";
}
