/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { sleep } from "@utils/misc";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { ChannelStore, Constants, GuildChannelStore, GuildStore, PermissionsBits, PermissionStore, RestAPI, WindowStore } from "@webpack/common";

import type { RawMessage } from "./native";

const Native = VencordNative.pluginHelpers.MessageArchive as PluginNative<typeof import("./native")>;
const logger = new Logger("MessageArchive");

const PAGE_SIZE = 50;
const IDLE_CHECK_MS = 30_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const DONE_KEY = "MessageArchive_doneChannels";

/** Bumped on start and stop so a sleeping backfill loop from an earlier run exits. */
let currentRun = 0;

const settings = definePluginSettings({
    backfill: {
        type: OptionType.BOOLEAN,
        description: "Scroll back through history while Discord is in the background, DMs first.",
        default: false
    },
    earliestStartHour: {
        type: OptionType.NUMBER,
        description: "Earliest hour of the day a backfill session can start.",
        default: 1
    },
    latestStartHour: {
        type: OptionType.NUMBER,
        description: "Latest hour of the day a backfill session can start.",
        default: 5
    },
    minSessionHours: {
        type: OptionType.NUMBER,
        description: "Shortest backfill session, in hours.",
        default: 1
    },
    maxSessionHours: {
        type: OptionType.NUMBER,
        description: "Longest backfill session, in hours.",
        default: 3
    },
    minIntervalSeconds: {
        type: OptionType.NUMBER,
        description: "Shortest wait between pages, in seconds.",
        default: 4
    },
    maxIntervalSeconds: {
        type: OptionType.NUMBER,
        description: "Longest wait between pages, in seconds.",
        default: 90
    }
});

const isMessage = (value: unknown): value is RawMessage =>
    typeof value === "object" && value !== null
    && "id" in value && "channel_id" in value && "author" in value;

function archive(messages: unknown[] | undefined) {
    const valid = messages?.flat().filter(isMessage);
    if (valid?.length) return Native.archive(valid);
}

const between = (min: number, max: number) => min + Math.random() * (max - min);

/** Picks the next session: a random start inside the start-hour window, then a random length. */
function nextSession(now: number) {
    const { earliestStartHour, latestStartHour, minSessionHours, maxSessionHours } = settings.store;
    const windowStart = new Date(now).setHours(earliestStartHour, 0, 0, 0);
    const windowHours = (latestStartHour - earliestStartHour + 24) % 24;

    let start = windowStart + between(0, windowHours) * HOUR_MS;
    if (start < now) start += DAY_MS;
    return { start, end: start + between(minSessionHours, maxSessionHours) * HOUR_MS };
}

function backfillOrder(): Channel[] {
    const guildChannels = GuildStore.getGuildIds().flatMap(guildId =>
        GuildChannelStore.getChannels(guildId).SELECTABLE
            .flatMap(entry => "channel" in entry ? [entry.channel] : [])
            .filter(channel => PermissionStore.can(PermissionsBits.READ_MESSAGE_HISTORY, channel))
    );
    return [...ChannelStore.getSortedPrivateChannels(), ...guildChannels];
}

const isRateLimit = (error: unknown) =>
    typeof error === "object" && error !== null && "status" in error && error.status === 429;

/** Fetches the page before the oldest archived message. Returns true once the channel's first message is archived. */
async function fetchOlder(channelId: string) {
    const before = await Native.oldestMessageId(channelId);
    const { body } = await RestAPI.get({
        url: Constants.Endpoints.MESSAGES(channelId),
        query: before ? { limit: PAGE_SIZE, before } : { limit: PAGE_SIZE }
    });
    await archive(body);
    return body.length < PAGE_SIZE;
}

/** Pages back through unfinished channels during randomly timed sessions while Discord is unfocused. */
async function backfill(run: number) {
    const done = new Set<string>(await DataStore.get(DONE_KEY) ?? []);
    let session = nextSession(Date.now());

    while (run === currentRun) {
        const now = Date.now();
        if (now >= session.end) session = nextSession(now);

        const channel = now >= session.start && settings.store.backfill && !WindowStore.isFocused()
            && backfillOrder().find(candidate => !done.has(candidate.id));
        if (!channel) {
            await sleep(IDLE_CHECK_MS);
            continue;
        }

        try {
            if (await fetchOlder(channel.id)) done.add(channel.id);
        } catch (error) {
            if (isRateLimit(error)) {
                logger.warn("Rate limited, ending this backfill session.");
                session.end = now;
                continue;
            }
            logger.warn(`Skipping channel ${channel.id}.`, error);
            done.add(channel.id);
        }

        await DataStore.set(DONE_KEY, [...done]);
        await sleep(between(settings.store.minIntervalSeconds, settings.store.maxIntervalSeconds) * 1000);
    }
}

export default definePlugin({
    name: "MessageArchive",
    description: "Saves every message Discord loads to disk, deduplicated.",
    authors: [EquicordDevs.mia],
    tags: ["Chat", "Utility"],
    settings,

    settingsAboutComponent: () => (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <Paragraph>
                Messages are written to one JSONL file per channel as you browse. Edits are kept as new lines.
            </Paragraph>
            <Button size="small" onClick={() => Native.openArchiveFolder()}>
                Open archive folder
            </Button>
        </div>
    ),

    start() {
        backfill(++currentRun);
    },

    stop() {
        currentRun++;
    },

    flux: {
        MESSAGE_CREATE({ optimistic, message }) {
            if (!optimistic) archive([message]);
        },
        MESSAGE_UPDATE({ message }) {
            archive([message]);
        },
        LOAD_MESSAGES_SUCCESS({ messages }) {
            archive(messages);
        },
        LOAD_RECENT_MENTIONS_SUCCESS({ messages }) {
            archive(messages);
        },
        SEARCH_FINISH({ messages }) {
            archive(messages);
        }
    }
});
