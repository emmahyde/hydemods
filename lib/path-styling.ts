const UNDERLINE = "\x1b[4m";
const UNDERLINE_OFF = "\x1b[24m";

/** Underline a label without resetting the caller's foreground or hyperlink state. */
export function underlineLabel(label: string): string {
	return `${UNDERLINE}${label}${UNDERLINE_OFF}`;
}

// Deliberately require a slash: this avoids underlining ordinary prose and bare URLs.
const PATH_TOKEN = /(?:~\/|\/|\.\.?\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?:[:#][A-Za-z0-9._-]+)*/g;

/** Underline filesystem-looking tokens while leaving URLs and prose untouched. */
export function underlinePathTokens(text: string): string {
	return text.replace(PATH_TOKEN, (token, offset: number, whole: string) => {
		const prefix = whole.slice(0, offset);
		if (/(?:https?|ftp):\/{1,2}$/i.test(prefix) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(token)) return token;
		return underlineLabel(token);
	});
}
