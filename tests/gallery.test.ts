import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { galleryStore, startGalleryServer, type GalleryServer } from "../lib/gallery";

const temps: string[] = [];
const servers: GalleryServer[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop();
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
	const dir = mkdtempSync(join(tmpdir(), "gallery-"));
	temps.push(dir);
	return dir;
};
// A 1x1 PNG.
const Png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const setup = () => {
	const project = temp();
	writeFileSync(join(project, "shot.png"), Png);
	writeFileSync(join(project, "notes.txt"), "not a picture");
	return { project, store: galleryStore(project, temp()) };
};
const port = () => 48000 + Math.floor(Math.random() * 1500);

test("a pushed picture is a copy: changing the original does not change the gallery", async () => {
	const { project, store } = setup();
	const item = await store.add({ path: "shot.png", caption: "first render", session: "s1", cwd: project });
	writeFileSync(join(project, "shot.png"), "overwritten");
	expect(Buffer.from(await Bun.file(store.itemPath(item.file)!).arrayBuffer()).equals(Png)).toBe(true);
	expect(store.read().items).toEqual([expect.objectContaining({ id: item.id, caption: "first render", session: "s1", source: "shot.png" })]);
});

test("push refuses files that are not images and paths that do not exist", async () => {
	const { project, store } = setup();
	await expect(store.add({ path: "notes.txt", cwd: project })).rejects.toThrow("not an image");
	await expect(store.add({ path: "missing.png", cwd: project })).rejects.toThrow("No file");
	expect(store.read().items).toEqual([]);
});

test("the page hears a push from any process as it happens", async () => {
	const { project, store } = setup();
	const server = await startGalleryServer(store, port());
	servers.push(server);
	const response = await fetch(`${server.url}events`);
	const reader = response.body!.getReader();
	await reader.read(); // retry hint
	expect(await server.viewers()).toBe(1);
	// A second store object for the same project stands in for another hydemods process.
	await galleryStore(project, store.dir.slice(0, store.dir.lastIndexOf("/"))).add({ path: "shot.png", cwd: project });
	// Real file-system watch: no fake clock drives it. The sleep only bounds a hang.
	const chunk = await Promise.race([reader.read(), Bun.sleep(2000).then(() => undefined)]);
	expect(new TextDecoder().decode(chunk?.value)).toContain("event: change");
	await reader.cancel();
});

test("a second process for the same project shares the server; another project moves to the next port", async () => {
	const { store } = setup();
	const base = port();
	const first = await startGalleryServer(store, base);
	servers.push(first);
	const shared = await startGalleryServer(galleryStore(store.dir, temp()), base);
	servers.push(shared);
	expect(shared.url).not.toBe(first.url);
	const same = await startGalleryServer(store, base);
	expect(same).toMatchObject({ url: first.url, owned: false });
});

test("the server only hands out files the manifest names, and only to its own host name", async () => {
	const { project, store } = setup();
	const item = await store.add({ path: "shot.png", cwd: project });
	const server = await startGalleryServer(store, port());
	servers.push(server);
	expect((await fetch(`${server.url}items/${item.file}`)).status).toBe(200);
	expect((await fetch(`${server.url}items/..%2Fmanifest.json`)).status).toBe(404);
	expect((await fetch(`${server.url}api/items`, { headers: { host: "evil.example" } })).status).toBe(403);
	expect((await fetch(`${server.url}api/items/${item.id}`, { method: "DELETE" })).status).toBe(204);
	expect(store.read().items).toEqual([]);
});

test("when the serving process stops, the next one takes over the port", async () => {
	const { store } = setup();
	const base = port();
	const first = await startGalleryServer(store, base);
	first.stop();
	const next = await startGalleryServer(store, base);
	servers.push(next);
	expect(next).toMatchObject({ url: first.url, owned: true });
});
