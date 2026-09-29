
/**
 * The host names a session twice on its own: once from the first prompt, and again from the
 * conversation whenever a todo list is initialised, as long as the name's source is still
 * "auto". A name set through the extension API is recorded as "user", which both of those
 * paths refuse to replace. This tweak takes the first naming over and locks it that way.
 */

const HOST_AUTO_TITLE_FLAG = "PI_NO_TITLE";

/**
 * The host checks `PI_NO_TITLE` from the live environment at every naming decision, so the
 * flag is the switch for its own generator. It is only cleared if this module set it: a user
 * who exported it themselves keeps it when the tweak turns off.
 */
export function setHostAutoTitle(enabled: boolean, env: Record<string, string | undefined> = Bun.env): void {
 if (!enabled) {
  if (env[HOST_AUTO_TITLE_FLAG] === undefined) env[HOST_AUTO_TITLE_FLAG] = "hydemods";
  return;
 }
 if (env[HOST_AUTO_TITLE_FLAG] === "hydemods") delete env[HOST_AUTO_TITLE_FLAG];
}

export interface TitleDecisionInput {
 prompt: string;
 sessionName: string | undefined;
 sessionId: string;
 /** Session id of a generation already running, if any. */
 inFlightFor: string | undefined;
 /** The prompt is a local slash command handled by an extension, not a request. */
 isLocalCommand: boolean;
}

/**
 * One generation per unnamed session. Chatter ("thanks", "ok") needs no check here: the host's
 * `generateSessionTitle` rejects low-signal input itself and returns null, so the next prompt retries.
 */
export function shouldGenerateTitle(input: TitleDecisionInput): boolean {
 if (input.isLocalCommand) return false;
 if (input.sessionName) return false;
 return input.inFlightFor !== input.sessionId;
}
