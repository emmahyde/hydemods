/**
 * Gallery sidecar: a live local web page the agent pushes pictures into, so images live in a
 * browser window beside the terminal instead of in its scrollback.
 *
 * One gallery per project. Every hydemods process for the same project writes the same folder
 * (`~/.omp/gallery/<project>-<hash>/`: `items/` plus `manifest.json`) and serves it on the same
 * port, so a tab you keep open survives sessions and restarts. Whichever process holds the port
 * serves; the others only write files, and the server's manifest check tells the page.
 */
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { galleryPage } from "./gallery-page";

export interface GalleryItem {
	id: string;
	/** File name inside `items/`. */
	file: string;
	caption?: string;
	/** Where the picture came from: a path or URL, as given. */
	source: string;
	session?: string;
	addedAt: number;
}

export interface Manifest {
	project: string;
	items: GalleryItem[];
}

const ImageTypes: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".avif": "image/avif",
	".bmp": "image/bmp",
};

/** Largest picture the gallery copies in. */
const MaxBytes = 50 * 1024 * 1024;

export interface GalleryStore {
	dir: string;
	project: string;
	read(): Manifest;
	add(input: { path?: string; url?: string; caption?: string; session?: string; cwd: string }): Promise<GalleryItem>;
	remove(id: string): boolean;
	clear(): number;
	itemPath(file: string): string | undefined;
}

export const galleryKey = (cwd: string): { name: string; hash: string } => {
	const hash = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 8);
	return { name: basename(resolve(cwd)) || "root", hash };
};

export function galleryStore(cwd: string, root = join(homedir(), ".omp", "gallery")): GalleryStore {
	const { name, hash } = galleryKey(cwd);
	const dir = join(root, `${name.replace(/[^\w.-]+/g, "_")}-${hash}`);
	const itemsDir = join(dir, "items");
	const manifestPath = join(dir, "manifest.json");
	const read = (): Manifest => {
		try {
			const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
			if (Array.isArray(parsed.items)) return { project: name, items: parsed.items };
		} catch {
			// Missing or torn manifest: start empty rather than fail the push.
		}
		return { project: name, items: [] };
	};
	const write = (manifest: Manifest) => {
		mkdirSync(dir, { recursive: true });
		const temp = `${manifestPath}.${process.pid}.tmp`;
		writeFileSync(temp, JSON.stringify(manifest, null, 1));
		renameSync(temp, manifestPath);
	};
	return {
		dir,
		project: name,
		read,
		async add({ path, url, caption, session, cwd: base }) {
			if (!path === !url) throw new Error("Give exactly one of path or url.");
			mkdirSync(itemsDir, { recursive: true });
			const id = randomUUID().slice(0, 8);
			let file: string;
			if (path) {
				const full = isAbsolute(path) ? path : resolve(base, path);
				if (!existsSync(full) || !statSync(full).isFile()) throw new Error(`No file at ${full}.`);
				const ext = extname(full).toLowerCase();
				if (!ImageTypes[ext]) throw new Error(`${basename(full)} is not an image the gallery shows (${Object.keys(ImageTypes).join(" ")}).`);
				if (statSync(full).size > MaxBytes) throw new Error(`${basename(full)} is larger than 50 MB.`);
				file = `${id}${ext}`;
				copyFileSync(full, join(itemsDir, file));
			} else {
				const response = await fetch(url!, { signal: AbortSignal.timeout(30_000) });
				if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
				const contentType = response.headers.get("content-type") ?? "";
				const urlExt = extname(new URL(url!).pathname).toLowerCase();
				const ext = Object.keys(ImageTypes).find(known => contentType.startsWith(ImageTypes[known])) ?? (ImageTypes[urlExt] ? urlExt : undefined);
				if (!ext) throw new Error(`${url} is not an image (content-type ${contentType || "none"}).`);
				const bytes = new Uint8Array(await response.arrayBuffer());
				if (bytes.byteLength > MaxBytes) throw new Error(`${url} is larger than 50 MB.`);
				file = `${id}${ext}`;
				writeFileSync(join(itemsDir, file), bytes);
			}
			const item: GalleryItem = { id, file, source: path ?? url!, addedAt: Date.now(), ...(caption ? { caption } : {}), ...(session ? { session } : {}) };
			const manifest = read();
			manifest.items.push(item);
			write(manifest);
			return item;
		},
		remove(id) {
			const manifest = read();
			const item = manifest.items.find(entry => entry.id === id);
			if (!item) return false;
			rmSync(join(itemsDir, item.file), { force: true });
			write({ ...manifest, items: manifest.items.filter(entry => entry.id !== id) });
			return true;
		},
		clear() {
			const { items } = read();
			for (const item of items) rmSync(join(itemsDir, item.file), { force: true });
			write({ project: name, items: [] });
			return items.length;
		},
		itemPath(file) {
			// Only names the manifest knows: no path from the request reaches the file system.
			return read().items.some(item => item.file === file) ? join(itemsDir, file) : undefined;
		},
	};
}

/** Stable per-project port, so a kept-open tab finds the next session's server. */
export const galleryPort = (cwd: string): number => 47100 + (Number.parseInt(galleryKey(cwd).hash, 16) % 800);

export interface GalleryServer {
	url: string;
	/** True when this process serves; false when another process for the project already does. */
	owned: boolean;
	/** Gallery tabs connected right now. */
	viewers(): Promise<number>;
	stop(): void;
}

/** Another server's /api/ping answer, or undefined when it does not answer like a gallery. */
async function ping(url: string): Promise<{ dir: string; viewers: number } | undefined> {
	try {
		const body: unknown = await (await fetch(`${url}api/ping`, { signal: AbortSignal.timeout(1000) })).json();
		if (!body || typeof body !== "object" || !("dir" in body) || typeof body.dir !== "string") return undefined;
		return { dir: body.dir, viewers: "viewers" in body && typeof body.viewers === "number" ? body.viewers : 0 };
	} catch {
		return undefined;
	}
}

/**
 * Serve the store on its project port. When the port is taken by another hydemods process for
 * the same project (it answers /api/ping with this store's folder), share it; any other holder
 * pushes us to the next ports.
 */
export async function startGalleryServer(store: GalleryStore, port: number): Promise<GalleryServer> {
	for (let attempt = 0; attempt < 10; attempt++) {
		const candidate = port + attempt;
		const url = `http://127.0.0.1:${candidate}/`;
		try {
			return serve(store, candidate, url);
		} catch {
			if ((await ping(url))?.dir === store.dir) return { url, owned: false, viewers: async () => (await ping(url))?.viewers ?? 0, stop() {} };
			// Otherwise something else holds the port: try the next one.
		}
	}
	throw new Error(`No free gallery port from ${port} to ${port + 9}.`);
}

function serve(store: GalleryStore, port: number, url: string): GalleryServer {
	const listeners = new Set<ReadableStreamDefaultController<Uint8Array>>();
	const encoder = new TextEncoder();
	const send = (message: string) => {
		for (const listener of listeners) {
			try {
				listener.enqueue(encoder.encode(message));
			} catch {
				listeners.delete(listener);
			}
		}
	};
	// Poll the manifest's stamp: fs.watch on macOS drops the rename events an atomic write makes.
	const manifestPath = join(store.dir, "manifest.json");
	const stamp = () => {
		try {
			const { mtimeMs, size } = statSync(manifestPath);
			return `${mtimeMs}:${size}`;
		} catch {
			return "";
		}
	};
	let seen = stamp();
	const check = setInterval(() => {
		if (!listeners.size) return;
		const now = stamp();
		if (now === seen) return;
		seen = now;
		send("event: change\ndata: {}\n\n");
	}, 250);
	const heartbeat = setInterval(() => send(": ping\n\n"), 20_000);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		idleTimeout: 0,
		async fetch(request) {
			// Refuse other host names, so a web page cannot reach the gallery by DNS rebinding.
			const host = request.headers.get("host") ?? "";
			if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return new Response("forbidden", { status: 403 });
			const { pathname } = new URL(request.url);
			if (pathname === "/") return new Response(galleryPage(store.project), { headers: { "content-type": "text/html; charset=utf-8" } });
			if (pathname === "/api/ping") return Response.json({ dir: store.dir, viewers: listeners.size });
			if (pathname === "/api/items" && request.method === "GET") return Response.json(store.read());
			if (pathname.startsWith("/api/items/") && request.method === "DELETE") {
				return store.remove(decodeURIComponent(pathname.slice("/api/items/".length))) ? new Response(null, { status: 204 }) : new Response("not found", { status: 404 });
			}
			if (pathname.startsWith("/items/")) {
				const path = store.itemPath(decodeURIComponent(pathname.slice("/items/".length)));
				if (!path) return new Response("not found", { status: 404 });
				return new Response(Bun.file(path), { headers: { "content-type": ImageTypes[extname(path).toLowerCase()] ?? "application/octet-stream", "cache-control": "max-age=31536000, immutable", "content-security-policy": "script-src 'none'" } });
			}
			if (pathname === "/events") {
				let own: ReadableStreamDefaultController<Uint8Array> | undefined;
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						own = controller;
						listeners.add(controller);
						controller.enqueue(encoder.encode("retry: 1500\n\n"));
					},
					cancel() {
						if (own) listeners.delete(own);
					},
				});
				return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
			}
			return new Response("not found", { status: 404 });
		},
	});
	return {
		url,
		owned: true,
		viewers: async () => listeners.size,
		stop() {
			clearInterval(heartbeat);
			clearInterval(check);
			for (const listener of listeners) {
				try {
					listener.close();
				} catch {
					// Already closed by the page.
				}
			}
			server.stop(true);
		},
	};
}
