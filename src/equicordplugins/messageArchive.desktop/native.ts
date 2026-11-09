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
const SNOWFLAKE = /^\d+$/;
const KINDS = new Set(["servers", "dms", "groups", "unsorted"]);
const MAX_IDS = 2;

/** The path comes from the renderer, so only a known kind followed by snowflakes may become folders. */
const isValidPath = ([kind, ...ids]: ConversationPath) =>
    KINDS.has(kind) && ids.length > 0 && ids.length <= MAX_IDS && ids.every(id => SNOWFLAKE.test(id));

/** Seen versions per conversation file, loaded lazily from that file. */
const seen = new Map<string, Set<string>>();

/** Writes run one at a time so concurrent batches never race on the seen sets. */
let queue = Promise.resolve();
/** Downloads run on their own queue so slow files never hold up message writes. */
let downloads = Promise.resolve();

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

    for (const { path, messages, attachments } of conversations) {
        if (!isValidPath(path)) continue;
        const base = join(dir, ...path);

        for (const attachment of attachments) {
            downloads = downloads.then(() => download(base, attachment, maxBytes)).catch(error => console.error("[MessageArchive]", error));
        }
        queue = queue.then(() => write(base, messages)).catch(error => console.error("[MessageArchive]", error));
    }

    return queue;
}

/** Asks for a folder, starting at the current one. Returns null when cancelled. */
export async function chooseFolder() {
    const { filePaths } = await dialog.showOpenDialog({ defaultPath: archiveDir(), properties: ["openDirectory", "createDirectory"] });
    return filePaths[0] ?? null;
}

export async function openArchiveFolder() {
    const dir = archiveDir();
    await mkdir(dir, { recursive: true });
    return shell.openPath(dir);
}
