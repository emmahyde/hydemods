/** The gallery's single HTML page. All item text reaches the DOM through textContent. */
export function galleryPage(project: string): string {
	const title = `${project} · gallery`.replace(/[<>&"]/g, char => `&#${char.charCodeAt(0)};`);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root { color-scheme: dark; --bg: #111214; --panel: #1a1c1f; --line: #2a2d31; --text: #e6e6e6; --muted: #8b9096; --accent: #7aa2f7; --new: #9ece6a; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif; }
header { position: sticky; top: 0; z-index: 2; display: flex; gap: 12px; align-items: center; padding: 8px 12px; background: var(--panel); border-bottom: 1px solid var(--line); }
header h1 { margin: 0; font-size: 13px; font-weight: 600; }
#status { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
#status.live { background: var(--new); }
#count { color: var(--muted); }
header input[type=search] { flex: 1; min-width: 80px; max-width: 280px; margin-left: auto; padding: 4px 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); color: var(--text); }
label.toggle { display: flex; gap: 4px; align-items: center; color: var(--muted); cursor: pointer; user-select: none; }
main { padding: 12px; }
h2 { margin: 16px 0 8px; font-size: 12px; font-weight: 500; color: var(--muted); }
h2:first-child { margin-top: 0; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--size, 220px), 1fr)); gap: 10px; }
figure { margin: 0; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; background: var(--panel); cursor: zoom-in; }
figure.fresh { border-color: var(--new); box-shadow: 0 0 0 1px var(--new); }
.thumb { aspect-ratio: 4 / 3; display: grid; place-items: center; }
.checker { background-color: #2b2e33; background-image: conic-gradient(#33373c 25%, transparent 0 50%, #33373c 0 75%, transparent 0); background-size: 16px 16px; }
.thumb img { max-width: 100%; max-height: 100%; object-fit: contain; }
figcaption { padding: 6px 8px; border-top: 1px solid var(--line); }
figcaption .meta { color: var(--muted); font-size: 11px; }
#empty { color: var(--muted); padding: 40px; text-align: center; }
#viewer { position: fixed; inset: 0; z-index: 3; display: none; grid-template-rows: 1fr auto; background: rgba(8, 9, 10, 0.96); }
#viewer.open { display: grid; }
#stage { overflow: auto; display: grid; place-items: center; min-height: 0; }
#stage img { max-width: 100%; max-height: 100%; object-fit: contain; cursor: zoom-in; }
#stage.actual img { max-width: none; max-height: none; cursor: zoom-out; }
#bar { display: flex; gap: 12px; align-items: center; padding: 8px 12px; background: var(--panel); border-top: 1px solid var(--line); }
#bar .text { flex: 1; min-width: 0; }
#bar .meta { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button { padding: 4px 10px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); color: var(--text); cursor: pointer; }
button:hover { border-color: var(--accent); }
kbd { padding: 0 4px; border: 1px solid var(--line); border-radius: 3px; color: var(--muted); font-size: 11px; }
</style>
</head>
<body>
<header>
<span id="status" title="disconnected"></span>
<h1>${title}</h1>
<span id="count"></span>
<input id="filter" type="search" placeholder="Filter captions">
<input id="size" type="range" min="120" max="480" value="220" title="Thumbnail size">
<label class="toggle" title="Open each new picture in the viewer"><input id="follow" type="checkbox" checked> follow</label>
</header>
<main id="main"><div id="empty">No pictures yet. The agent adds them with the gallery tool.</div></main>
<div id="viewer">
<div id="stage" class="checker"><img id="big" alt=""></div>
<div id="bar">
<div class="text"><div id="caption"></div><div id="meta" class="meta"></div></div>
<span class="meta"><kbd>←</kbd><kbd>→</kbd> move · <kbd>f</kbd> fit · <kbd>c</kbd> copy source · <kbd>d</kbd> delete · <kbd>esc</kbd> close</span>
<button id="copy">Copy source</button>
<button id="delete">Delete</button>
<button id="close">Close</button>
</div>
</div>
<script>
const state = { items: [], shown: [], at: -1, known: null, fresh: new Set() };
const $ = id => document.getElementById(id);
const time = ms => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const follow = $("follow");
follow.checked = localStorage.getItem("gallery.follow") !== "0";
follow.onchange = () => localStorage.setItem("gallery.follow", follow.checked ? "1" : "0");
const size = $("size");
size.value = localStorage.getItem("gallery.size") || "220";
const applySize = () => { document.documentElement.style.setProperty("--size", size.value + "px"); localStorage.setItem("gallery.size", size.value); };
size.oninput = applySize;
applySize();
$("filter").oninput = render;

function render() {
	const query = $("filter").value.trim().toLowerCase();
	state.shown = state.items.filter(item => !query || (item.caption || "").toLowerCase().includes(query) || item.source.toLowerCase().includes(query)).reverse();
	$("count").textContent = state.items.length + (state.items.length === 1 ? " picture" : " pictures");
	const main = $("main");
	main.replaceChildren();
	if (!state.shown.length) {
		const empty = document.createElement("div");
		empty.id = "empty";
		empty.textContent = state.items.length ? "No caption matches." : "No pictures yet. The agent adds them with the gallery tool.";
		main.append(empty);
		return;
	}
	let group = null, grid = null;
	state.shown.forEach((item, index) => {
		const label = item.session || "No session";
		if (label !== group) {
			group = label;
			const heading = document.createElement("h2");
			heading.textContent = label;
			grid = document.createElement("div");
			grid.className = "grid";
			main.append(heading, grid);
		}
		const figure = document.createElement("figure");
		if (state.fresh.has(item.id)) figure.className = "fresh";
		const thumb = document.createElement("div");
		thumb.className = "thumb checker";
		const img = document.createElement("img");
		img.loading = "lazy";
		img.src = "/items/" + encodeURIComponent(item.file);
		img.alt = item.caption || "";
		thumb.append(img);
		const caption = document.createElement("figcaption");
		const text = document.createElement("div");
		text.textContent = item.caption || item.source.split("/").pop();
		const meta = document.createElement("div");
		meta.className = "meta";
		meta.textContent = time(item.addedAt);
		caption.append(text, meta);
		figure.append(thumb, caption);
		figure.onclick = () => openAt(index);
		grid.append(figure);
	});
}

function openAt(index) {
	if (!state.shown.length) return closeViewer();
	state.at = Math.max(0, Math.min(index, state.shown.length - 1));
	const item = state.shown[state.at];
	state.fresh.delete(item.id);
	$("big").src = "/items/" + encodeURIComponent(item.file);
	$("caption").textContent = item.caption || "";
	$("meta").textContent = (state.at + 1) + " / " + state.shown.length + " · " + time(item.addedAt) + " · " + item.source;
	$("stage").classList.remove("actual");
	$("viewer").classList.add("open");
}
function closeViewer() { $("viewer").classList.remove("open"); state.at = -1; render(); }
const current = () => state.shown[state.at];
async function removeCurrent() {
	const item = current();
	if (!item) return;
	await fetch("/api/items/" + encodeURIComponent(item.id), { method: "DELETE" });
}
function copyCurrent() { const item = current(); if (item) navigator.clipboard.writeText(item.source); }

$("big").onclick = () => $("stage").classList.toggle("actual");
$("close").onclick = closeViewer;
$("delete").onclick = removeCurrent;
$("copy").onclick = copyCurrent;
document.addEventListener("keydown", event => {
	if (!$("viewer").classList.contains("open") || event.target.tagName === "INPUT") return;
	if (event.key === "Escape") closeViewer();
	else if (event.key === "ArrowRight" || event.key === "j") openAt(state.at + 1);
	else if (event.key === "ArrowLeft" || event.key === "k") openAt(state.at - 1);
	else if (event.key === "f") $("stage").classList.toggle("actual");
	else if (event.key === "d") removeCurrent();
	else if (event.key === "c") copyCurrent();
});

async function load() {
	const manifest = await (await fetch("/api/items")).json();
	const viewing = current()?.id;
	const added = state.known ? manifest.items.filter(item => !state.known.has(item.id)) : [];
	state.known = new Set(manifest.items.map(item => item.id));
	for (const item of added) state.fresh.add(item.id);
	state.items = manifest.items;
	render();
	if (added.length && follow.checked) openAt(state.shown.findIndex(item => item.id === added.at(-1).id));
	else if (viewing) {
		const index = state.shown.findIndex(item => item.id === viewing);
		index >= 0 ? openAt(index) : $("viewer").classList.contains("open") && openAt(state.at);
	}
}

function connect() {
	const events = new EventSource("/events");
	events.onopen = () => { $("status").className = "live"; $("status").title = "live"; load(); };
	events.addEventListener("change", load);
	events.onerror = () => { $("status").className = ""; $("status").title = "reconnecting"; };
}
connect();
</script>
</body>
</html>`;
}
