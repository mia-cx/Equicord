/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, sendBotMessage } from "@api/Commands";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { sleep } from "@utils/misc";
import { formatDurationMs } from "@utils/text";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { ChannelStore, Constants, GuildChannelStore, GuildStore, PermissionsBits, PermissionStore, React, RestAPI, TextInput, useState, WindowStore } from "@webpack/common";

import type { RawMessage } from "./native";

const Native = VencordNative.pluginHelpers.MessageArchive as PluginNative<typeof import("./native")>;
const logger = new Logger("MessageArchive");

const PAGE_SIZE = 50;
const IDLE_CHECK_MS = 30_000;
const SECOND_MS = 1000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const DONE_KEY = "MessageArchive_doneChannels";

type Range = [min: number, max: number];

interface Schedule {
    startHours: Range;
    sessionHours: Range;
    pageSeconds: Range;
    jitterPercent: number;
}

const DEFAULT_SCHEDULE: Schedule = {
    startHours: [1, 5],
    sessionHours: [1, 3],
    pageSeconds: [6, 30],
    jitterPercent: 75
};

const RANGE_ROWS = [
    { key: "startHours", label: "Start between", joiner: "and", unit: "o'clock" },
    { key: "sessionHours", label: "Run for", joiner: "to", unit: "hours" },
    { key: "pageSeconds", label: "Wait per page", joiner: "to", unit: "seconds" }
] as const;

interface Session {
    start: number;
    end: number;
    pageMs: number;
    manual: boolean;
}

/** Bumped on start and stop so a sleeping backfill loop from an earlier run exits. */
let currentRun = 0;
let session: Session;

interface NumberInputProps {
    value: number;
    label: string;
    onChange(value: number): void;
}

function NumberInput({ value, label, onChange }: NumberInputProps) {
    return (
        <TextInput type="number" value={String(value)} aria-label={label} onChange={next => onChange(Number(next))} />
    );
}

function ScheduleSettings() {
    const [schedule, setSchedule] = useState<Schedule>(() => settings.store.schedule);

    const update = (next: Schedule) => {
        setSchedule(next);
        settings.store.schedule = next;
    };

    return (
        <div style={{ display: "grid", gridTemplateColumns: "auto 80px auto 80px auto", gap: "8px", alignItems: "center" }}>
            {RANGE_ROWS.map(({ key, label, joiner, unit }) => (
                <React.Fragment key={key}>
                    <Paragraph>{label}</Paragraph>
                    <NumberInput value={schedule[key][0]} label={`${label} minimum`} onChange={min => update({ ...schedule, [key]: [min, schedule[key][1]] })} />
                    <Paragraph>{joiner}</Paragraph>
                    <NumberInput value={schedule[key][1]} label={`${label} maximum`} onChange={max => update({ ...schedule, [key]: [schedule[key][0], max] })} />
                    <Paragraph>{unit}</Paragraph>
                </React.Fragment>
            ))}
            <Paragraph>Jitter</Paragraph>
            <NumberInput value={schedule.jitterPercent} label="Jitter" onChange={jitterPercent => update({ ...schedule, jitterPercent })} />
            <Paragraph>% either way</Paragraph>
        </div>
    );
}

const settings = definePluginSettings({
    autoBackfill: {
        type: OptionType.BOOLEAN,
        description: "Scroll back through history on a schedule while Discord is in the background, DMs first.",
        default: false
    },
    schedule: {
        type: OptionType.COMPONENT,
        description: "Each session picks a random start, length, and page wait from these ranges. Every wait then varies by the jitter.",
        default: DEFAULT_SCHEDULE,
        component: ScheduleSettings
    }
});

const isMessage = (value: unknown): value is RawMessage =>
    typeof value === "object" && value !== null
    && "id" in value && "channel_id" in value && "author" in value;

function archive(messages: unknown[] | undefined) {
    const valid = messages?.flat().filter(isMessage);
    if (valid?.length) return Native.archive(valid);
}

const between = ([min, max]: Range) => min + Math.random() * (max - min);

function createSession(start: number, manual: boolean): Session {
    const { sessionHours, pageSeconds } = settings.store.schedule;
    return { start, end: start + between(sessionHours) * HOUR_MS, pageMs: between(pageSeconds) * SECOND_MS, manual };
}

/** Picks a random start inside the start-hour window, tomorrow if today's has passed. */
function nextScheduledSession(now: number) {
    const [earliest, latest] = settings.store.schedule.startHours;
    const windowStart = new Date(now).setHours(earliest, 0, 0, 0);
    const windowHours = (latest - earliest + 24) % 24;

    const start = windowStart + between([0, windowHours]) * HOUR_MS;
    return createSession(start < now ? start + DAY_MS : start, false);
}

function pageWait() {
    const jitter = settings.store.schedule.jitterPercent / 100;
    return Math.max(0, session.pageMs * (1 + between([-jitter, jitter])));
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

/** Pages back through unfinished channels during sessions. Scheduled sessions pause while Discord is focused. */
async function backfill(run: number) {
    session = nextScheduledSession(Date.now());
    const done = new Set<string>(await DataStore.get(DONE_KEY) ?? []);

    while (run === currentRun) {
        const now = Date.now();
        if (now >= session.end) session = nextScheduledSession(now);

        const active = now >= session.start && (session.manual || settings.store.autoBackfill && !WindowStore.isFocused());
        const channel = active && backfillOrder().find(candidate => !done.has(candidate.id));
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
        await sleep(pageWait());
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
                Run /backfill to start or stop a session right away.
            </Paragraph>
            <Button size="small" onClick={() => Native.openArchiveFolder()}>
                Open archive folder
            </Button>
        </div>
    ),

    commands: [{
        name: "backfill",
        description: "Start or stop a backfill session now.",
        inputType: ApplicationCommandInputType.BUILT_IN,
        execute(_, ctx) {
            const now = Date.now();
            if (session.manual && now < session.end) {
                session = nextScheduledSession(now);
                sendBotMessage(ctx.channel.id, { content: "Backfill stopped." });
                return;
            }

            session = createSession(now, true);
            sendBotMessage(ctx.channel.id, { content: `Backfill started for ${formatDurationMs(session.end - now, true, false)}.` });
        }
    }],

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
