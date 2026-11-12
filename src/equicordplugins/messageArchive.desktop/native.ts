/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { DATA_DIR } from "@main/utils/constants";
import { IpcMainInvokeEvent, shell } from "electron";

/** A raw Discord API message, as carried by Flux events. */
export interface RawMessage {
    id: string;
    channel_id: string;
    edited_timestamp?: string | null;
    [key: string]: unknown;
}

const ARCHIVE_DIR = join(DATA_DIR, "MessageArchive");
const SNOWFLAKE = /^\d{1,20}$/;

/** Seen versions per channel, loaded lazily from that channel's file. */
const seen = new Map<string, Set<string>>();

/** One message id per edit, so later edits append a new version and repeats are skipped. */
const versionKey = (message: RawMessage) => `${message.id}:${message.edited_timestamp ?? ""}`;

const channelFile = (channelId: string) => join(ARCHIVE_DIR, `${channelId}.jsonl`);

/** Archive work runs one task at a time so the seen sets never race. */
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task);
    queue = result.catch(error => console.error("[MessageArchive]", error));
    return result;
}

async function loadSeen(channelId: string): Promise<Set<string>> {
    const cached = seen.get(channelId);
    if (cached) return cached;

    const keys = new Set<string>();
    const contents = await readFile(channelFile(channelId), "utf8").catch(() => "");
    for (const line of contents.split("\n")) {
        if (line) keys.add(versionKey(JSON.parse(line)));
    }

    seen.set(channelId, keys);
    return keys;
}

async function write(messages: RawMessage[]) {
    await mkdir(ARCHIVE_DIR, { recursive: true });

    const byChannel = Map.groupBy(messages, message => message.channel_id);
    for (const [channelId, channelMessages] of byChannel) {
        if (!SNOWFLAKE.test(channelId)) continue;

        const keys = await loadSeen(channelId);
        const fresh = channelMessages.filter(message => {
            const key = versionKey(message);
            if (keys.has(key)) return false;
            keys.add(key);
            return true;
        });

        if (fresh.length) {
            await appendFile(channelFile(channelId), fresh.map(message => JSON.stringify(message) + "\n").join(""));
        }
    }
}

/** Appends every unseen message version to `<channel_id>.jsonl` in the archive folder. */
export function archive(_: IpcMainInvokeEvent, messages: RawMessage[]) {
    return enqueue(() => write(messages));
}

/** The oldest archived message id in a channel, or null when nothing is archived yet. */
export function oldestMessageId(_: IpcMainInvokeEvent, channelId: string) {
    if (!SNOWFLAKE.test(channelId)) return null;

    return enqueue(async () => {
        let oldest: bigint | null = null;
        for (const key of await loadSeen(channelId)) {
            const id = BigInt(key.slice(0, key.indexOf(":")));
            if (oldest === null || id < oldest) oldest = id;
        }
        return oldest?.toString() ?? null;
    });
}

export function openArchiveFolder() {
    return mkdir(ARCHIVE_DIR, { recursive: true }).then(() => shell.openPath(ARCHIVE_DIR));
}
