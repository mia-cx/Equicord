/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

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
    edited_timestamp?: string | null;
    attachments?: RawAttachment[];
    [key: string]: unknown;
}

/** An attachment to download, tagged with the channel whose folder it goes in. */
export type ArchivedAttachment = RawAttachment & { channel_id: string; };

const DEFAULT_DIR = join(DATA_DIR, "MessageArchive");
const ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const SNOWFLAKE = /^\d{1,20}$/;

/** Seen versions per channel file, loaded lazily from that file. */
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

const channelFile = (dir: string, channelId: string) => join(dir, `${channelId}.jsonl`);

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

async function write(dir: string, messages: RawMessage[]) {
    await mkdir(dir, { recursive: true });

    const byChannel = Map.groupBy(messages, message => message.channel_id);
    for (const [channelId, channelMessages] of byChannel) {
        if (!SNOWFLAKE.test(channelId)) continue;

        const file = channelFile(dir, channelId);
        const keys = await loadSeen(file);
        const fresh = channelMessages.filter(message => {
            const key = versionKey(message);
            if (keys.has(key)) return false;
            keys.add(key);
            return true;
        });

        if (fresh.length) {
            await appendFile(file, fresh.map(message => JSON.stringify(message) + "\n").join(""));
        }
    }
}

async function download(dir: string, attachment: ArchivedAttachment, maxBytes: number) {
    if (!SNOWFLAKE.test(attachment.id) || !SNOWFLAKE.test(attachment.channel_id)) return;
    if (!ATTACHMENT_HOSTS.has(new URL(attachment.url).hostname) || attachment.size > maxBytes) return;

    const folder = join(dir, "attachments", attachment.channel_id);
    const file = join(folder, `${attachment.id}-${basename(attachment.filename)}`);
    if (await access(file).then(() => true, () => false)) return;

    const response = await fetch(attachment.url);
    if (!response.ok) throw new Error(`${response.status} for attachment ${attachment.id}`);
    if (Number(response.headers.get("content-length")) > maxBytes) return;

    await mkdir(folder, { recursive: true });
    await writeFile(file, new Uint8Array(await response.arrayBuffer()));
}

/**
 * Appends every unseen message version to `<channel_id>.jsonl` and saves the given attachments to
 * `attachments/<channel_id>/<attachment_id>-<filename>`, both in the archive folder.
 */
export function archive(_: IpcMainInvokeEvent, messages: RawMessage[], attachments: ArchivedAttachment[], maxBytes: number) {
    const dir = archiveDir();

    for (const attachment of attachments) {
        downloads = downloads.then(() => download(dir, attachment, maxBytes)).catch(error => console.error("[MessageArchive]", error));
    }

    return enqueue(() => write(dir, messages));
}

/** The oldest archived message id in a channel, or null when nothing is archived yet. */
export function oldestMessageId(_: IpcMainInvokeEvent, channelId: string) {
    if (!SNOWFLAKE.test(channelId)) return null;
    const file = channelFile(archiveDir(), channelId);

    return enqueue(async () => {
        let oldest: bigint | null = null;
        for (const key of await loadSeen(file)) {
            const id = BigInt(key.slice(0, key.indexOf(":")));
            if (oldest === null || id < oldest) oldest = id;
        }
        return oldest?.toString() ?? null;
    });
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
