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
const DAILY_REQUEST_CAP = 1000;
const REQUEST_DELAY_MS = 3000;
const REQUEST_JITTER_MS = 5000;
const BURST_SIZE = 25;
const BURST_PAUSE_MS = 3 * 60_000;
const IDLE_CHECK_MS = 30_000;
const STATE_KEY = "MessageArchive_backfill";

/** Bumped on start and stop so a sleeping backfill loop from an earlier run exits. */
let currentRun = 0;

interface BackfillState {
    /** Oldest message fetched per channel, or null once the channel is fully archived. */
    cursors: Record<string, string | null>;
    day: string;
    requests: number;
}

const settings = definePluginSettings({
    backfill: {
        type: OptionType.BOOLEAN,
        description: "Scroll back through history while Discord is in the background, DMs first.",
        default: false
    }
});

const isMessage = (value: unknown): value is RawMessage =>
    typeof value === "object" && value !== null
    && "id" in value && "channel_id" in value && "author" in value;

function archive(messages: unknown[] | undefined) {
    const valid = messages?.flat().filter(isMessage);
    if (valid?.length) Native.archive(valid);
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

async function fetchPage(channelId: string, state: BackfillState) {
    const before = state.cursors[channelId];
    try {
        const { body } = await RestAPI.get({
            url: Constants.Endpoints.MESSAGES(channelId),
            query: before ? { limit: PAGE_SIZE, before } : { limit: PAGE_SIZE }
        });
        archive(body);
        state.cursors[channelId] = body.length < PAGE_SIZE ? null : body.at(-1).id;
    } catch (error) {
        if (isRateLimit(error)) {
            logger.warn("Rate limited, pausing backfill until tomorrow.");
            state.requests = DAILY_REQUEST_CAP;
            return;
        }
        logger.warn(`Skipping channel ${channelId}.`, error);
        state.cursors[channelId] = null;
    }
}

/** Fetches one page at a time while Discord is unfocused, until every channel reaches its first message. */
async function backfill(run: number) {
    const state: BackfillState = await DataStore.get(STATE_KEY) ?? { cursors: {}, day: "", requests: 0 };

    while (run === currentRun) {
        const today = new Date().toDateString();
        if (state.day !== today) Object.assign(state, { day: today, requests: 0 });

        const channel = settings.store.backfill && !WindowStore.isFocused() && state.requests < DAILY_REQUEST_CAP
            && backfillOrder().find(candidate => state.cursors[candidate.id] !== null);
        if (!channel) {
            await sleep(IDLE_CHECK_MS);
            continue;
        }

        await fetchPage(channel.id, state);
        state.requests++;
        await DataStore.set(STATE_KEY, state);
        await sleep(state.requests % BURST_SIZE ? REQUEST_DELAY_MS + Math.random() * REQUEST_JITTER_MS : BURST_PAUSE_MS);
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
