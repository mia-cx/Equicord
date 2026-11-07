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

/** Seen versions per channel, loaded lazily from that channel's file. */
const seen = new Map<string, Set<string>>();

/** Writes run one at a time so concurrent batches never race on the seen sets. */
let queue = Promise.resolve();

/** One message id per edit, so later edits append a new version and repeats are skipped. */
const versionKey = (message: RawMessage) => `${message.id}:${message.edited_timestamp ?? ""}`;

const channelFile = (channelId: string) => join(ARCHIVE_DIR, `${channelId}.jsonl`);

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
    queue = queue.then(() => write(messages)).catch(error => console.error("[MessageArchive]", error));
    return queue;
}

export function openArchiveFolder() {
    return mkdir(ARCHIVE_DIR, { recursive: true }).then(() => shell.openPath(ARCHIVE_DIR));
}
