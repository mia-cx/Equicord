/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { RendererSettings } from "@main/settings";
import { DATA_DIR } from "@main/utils/constants";
import { dialog, IpcMainInvokeEvent, shell } from "electron";
import { Unzipped, unzipSync } from "fflate";

/** A raw Discord API attachment, as carried inside a raw message. */
export interface RawAttachment {
    id: string;
    filename: string;
    url: string;
    size: number;
    content_type?: string;
}

/** A raw Discord API message, as carried by Flux events. */
export interface RawMessage {
    id: string;
    channel_id: string;
    guild_id?: string;
    edited_timestamp?: string | null;
    attachments?: RawAttachment[];
    [key: string]: unknown;
}

/** Where a conversation lives under the archive folder, e.g. `["servers", guildId, channelId]` or `["dms", userId]`. */
export type ConversationPath = string[];

/** One conversation's messages and the attachments to download from them. */
export interface Conversation {
    path: ConversationPath;
    messages: RawMessage[];
    attachments: RawAttachment[];
}

const DEFAULT_DIR = join(DATA_DIR, "MessageArchive");
const ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const SNOWFLAKE = /^\d{1,20}$/;
const KINDS = new Set(["servers", "dms", "groups", "unsorted"]);
const MAX_IDS = 2;

/** The path comes from the renderer, so only a known kind followed by snowflakes may become folders. */
const isValidPath = ([kind, ...ids]: ConversationPath) =>
    KINDS.has(kind) && ids.length > 0 && ids.length <= MAX_IDS && ids.every(id => SNOWFLAKE.test(id));

/** Seen versions per conversation file, loaded lazily from that file. */
const seen = new Map<string, Set<string>>();

/** Archive work runs one task at a time so the seen sets never race. */
let queue: Promise<unknown> = Promise.resolve();
/** Downloads run on their own queue so slow files never hold up message writes. */
let downloads = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task);
    queue = result.catch(error => console.error("[MessageArchive]", error));
    return result;
}

/** The folder chosen in settings, or the default. Read here so the renderer never hands us a path. */
const archiveDir = (): string => RendererSettings.store.plugins?.MessageArchive?.folder || DEFAULT_DIR;

/** One message id per edit, so later edits append a new version and repeats are skipped. */
const versionKey = (message: RawMessage) => `${message.id}:${message.edited_timestamp ?? ""}`;

async function loadSeen(file: string): Promise<Set<string>> {
    const cached = seen.get(file);
    if (cached) return cached;

    const keys = new Set<string>();
    const contents = await readFile(file, "utf8").catch(() => "");
    for (const line of contents.split("\n")) {
        if (line) keys.add(versionKey(JSON.parse(line)));
    }

    seen.set(file, keys);
    return keys;
}

async function write(base: string, messages: RawMessage[]) {
    const file = `${base}.jsonl`;
    const keys = await loadSeen(file);
    const fresh = messages.filter(message => {
        const key = versionKey(message);
        if (keys.has(key)) return false;
        keys.add(key);
        return true;
    });
    if (!fresh.length) return;

    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, fresh.map(message => JSON.stringify(message) + "\n").join(""));
}

async function download(folder: string, attachment: RawAttachment, maxBytes: number) {
    if (!SNOWFLAKE.test(attachment.id)) return;
    if (!ATTACHMENT_HOSTS.has(new URL(attachment.url).hostname) || attachment.size > maxBytes) return;

    const file = join(folder, `${attachment.id}-${basename(attachment.filename)}`);
    if (await access(file).then(() => true, () => false)) return;

    const response = await fetch(attachment.url);
    if (!response.ok) throw new Error(`${response.status} for attachment ${attachment.id}`);
    if (Number(response.headers.get("content-length")) > maxBytes) return;

    await mkdir(folder, { recursive: true });
    await writeFile(file, new Uint8Array(await response.arrayBuffer()));
}

/**
 * Appends every unseen message version to `<path>.jsonl` and saves attachments to
 * `<path>/<attachment_id>-<filename>`, both under the archive folder.
 */
export function archive(_: IpcMainInvokeEvent, conversations: Conversation[], maxBytes: number) {
    const dir = archiveDir();
    const valid = conversations.filter(({ path }) => isValidPath(path));

    for (const { path, attachments } of valid) {
        for (const attachment of attachments) {
            downloads = downloads.then(() => download(join(dir, ...path), attachment, maxBytes)).catch(error => console.error("[MessageArchive]", error));
        }
    }

    return enqueue(async () => {
        for (const { path, messages } of valid) await write(join(dir, ...path), messages);
    });
}

/** The oldest archived message id in a conversation, or null when nothing is archived yet. */
export function oldestMessageId(_: IpcMainInvokeEvent, path: ConversationPath) {
    if (!isValidPath(path)) return null;
    const file = `${join(archiveDir(), ...path)}.jsonl`;

    return enqueue(async () => {
        let oldest: bigint | null = null;
        for (const key of await loadSeen(file)) {
            const id = BigInt(key.slice(0, key.indexOf(":")));
            if (oldest === null || id < oldest) oldest = id;
        }
        return oldest?.toString() ?? null;
    });
}

/** The index of the first of `ids` not yet in a conversation's archive, or -1 when every one is archived. */
export function firstUnarchived(_: IpcMainInvokeEvent, path: ConversationPath, ids: string[]) {
    if (!isValidPath(path)) return -1;
    const file = `${join(archiveDir(), ...path)}.jsonl`;

    return enqueue(async () => {
        const archived = new Set(Array.from(await loadSeen(file), key => key.slice(0, key.indexOf(":"))));
        return ids.findIndex(id => !archived.has(id));
    });
}

/** A channel from a Discord data package, with the ids of your own messages in it, newest first. */
export interface PackageChannel {
    channelId: string;
    guildId?: string;
    messageIds: string[];
}

const PACKAGE_FILE = /^Messages\/c(\d{1,20})\/(messages|channel)\.json$/;
/** Matched as text because the package writes ids as JSON numbers, which `JSON.parse` would round. */
const MESSAGE_ID = /"ID":\s*(\d{1,20})/g;

const newestFirst = (a: string, b: string) => b.length - a.length || (a < b ? 1 : a > b ? -1 : 0);

/**
 * Asks for a Discord data package and reads your messages out of it, grouped by channel. Channels come in order of
 * your latest message in them. Only the message and channel files are unpacked, synchronously, because fflate's
 * async unzip starts a worker per file and takes nearly a minute on a package with thousands of channels.
 * Returns null when cancelled.
 */
export async function importPackage(): Promise<PackageChannel[] | null> {
    const { filePaths: [file] } = await dialog.showOpenDialog({ properties: ["openFile"], filters: [{ name: "Discord data package", extensions: ["zip"] }] });
    if (!file) return null;

    const data = new Uint8Array(await readFile(file));
    let files: Unzipped;
    try {
        files = unzipSync(data, { filter: ({ name }) => PACKAGE_FILE.test(name) });
    } catch {
        throw new Error("That file isn't a readable zip.");
    }

    const channels = new Map<string, PackageChannel>();
    const decoder = new TextDecoder();
    for (const [name, contents] of Object.entries(files)) {
        const match = PACKAGE_FILE.exec(name);
        if (!match) continue;

        const [, channelId, kind] = match;
        const channel = channels.get(channelId) ?? { channelId, messageIds: [] };
        channels.set(channelId, channel);

        const text = decoder.decode(contents);
        if (kind === "messages") {
            channel.messageIds = Array.from(text.matchAll(MESSAGE_ID), ([, id]) => id).sort(newestFirst);
            continue;
        }
        const guildId = JSON.parse(text).guild?.id;
        if (SNOWFLAKE.test(guildId)) channel.guildId = guildId;
    }

    return [...channels.values()]
        .filter(({ messageIds }) => messageIds.length)
        .sort((a, b) => newestFirst(a.messageIds[0], b.messageIds[0]));
}

/** Asks for a folder, starting at the current one. Returns null when cancelled. */
export async function chooseFolder() {
    const { filePaths } = await dialog.showOpenDialog({ defaultPath: archiveDir(), properties: ["openDirectory", "createDirectory"] });
    return filePaths[0] ?? null;
}

const SCROLL_KEYS = new Set(["Home", "PageUp", "PageDown"]);

/** Presses a scroll key in Discord's window as real input, so the browser scrolls the focused list itself. */
export function pressKey({ sender }: IpcMainInvokeEvent, key: string) {
    if (!SCROLL_KEYS.has(key)) return;
    sender.sendInputEvent({ type: "keyDown", keyCode: key });
    sender.sendInputEvent({ type: "keyUp", keyCode: key });
}

export async function openArchiveFolder() {
    const dir = archiveDir();
    await mkdir(dir, { recursive: true });
    return shell.openPath(dir);
}
