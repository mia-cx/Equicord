/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption } from "@api/Commands";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { sleep } from "@utils/misc";
import { formatDurationMs } from "@utils/text";
import definePlugin, { OptionType, PluginNative, PluginSettingComponentProps } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { ChannelStore, Constants, GuildChannelStore, GuildStore, PermissionsBits, PermissionStore, React, RestAPI, showToast, TextInput, useState, WindowStore } from "@webpack/common";

import type { Conversation, ConversationPath, RawAttachment, RawMessage } from "./native";

const Native = VencordNative.pluginHelpers.MessageArchive as PluginNative<typeof import("./native")>;
const logger = new Logger("MessageArchive");

const BYTES_PER_MB = 1024 * 1024;
const FOLDER_KEYS: ["folder"] = ["folder"];
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
    /** Set by /backfill: this channel goes first, and the session ends with it unless `continueAfter`. */
    channelId?: string;
    continueAfter?: boolean;
    /** Set by /backfill pause; resuming pushes `end` back by the time spent paused. */
    pausedAt?: number;
}

/** Bumped on start and stop so a sleeping backfill loop from an earlier run exits. */
let currentRun = 0;
let session: Session;
let done = new Set<string>();

/** Ends the loop's current wait early, so a command takes effect right away. */
let wakeUp = () => { };
const nap = (ms: number) => Promise.race([sleep(ms), new Promise<void>(resolve => { wakeUp = resolve; })]);

function FolderSetting({ setValue }: PluginSettingComponentProps) {
    const { folder } = settings.use(FOLDER_KEYS);

    async function choose() {
        const dir = await Native.chooseFolder();
        if (dir) setValue(dir);
    }

    return (
        <section style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <Heading>Archive folder</Heading>
            <Paragraph>{folder || "EquicordData/MessageArchive"}</Paragraph>
            <div style={{ display: "flex", gap: "8px" }}>
                <Button size="small" onClick={choose}>Choose folder</Button>
                <Button size="small" variant="secondary" onClick={() => Native.openArchiveFolder()}>Open folder</Button>
                {folder && <Button size="small" variant="secondary" onClick={() => setValue("")}>Use default</Button>}
            </div>
        </section>
    );
}

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
    folder: {
        type: OptionType.COMPONENT,
        default: "",
        component: FolderSetting
    },
    directMessages: {
        type: OptionType.BOOLEAN,
        description: "Archive direct messages and group DMs.",
        default: true
    },
    servers: {
        type: OptionType.BOOLEAN,
        description: "Archive server channels.",
        default: true
    },
    saveMedia: {
        type: OptionType.BOOLEAN,
        description: "Download images and videos. Fetches each file from Discord's CDN once.",
        default: false
    },
    saveFiles: {
        type: OptionType.BOOLEAN,
        description: "Download every other attachment, like documents and audio.",
        default: false
    },
    maxFileSize: {
        type: OptionType.SLIDER,
        description: "Skip attachments larger than this many megabytes.",
        markers: [1, 10, 25, 50, 100, 500],
        default: 25
    },
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

const isMedia = ({ content_type }: RawAttachment) => /^(image|video)\//.test(content_type ?? "");

/** Servers nest channels under the guild, DMs are named after the other user. Channels Discord hasn't loaded go to `unsorted`. */
function conversationPath(channelId: string, messageGuildId?: string): ConversationPath {
    const channel = ChannelStore.getChannel(channelId);
    if (channel?.isDM()) return ["dms", channel.getRecipientId() ?? channelId];
    if (channel?.isGroupDM()) return ["groups", channelId];

    const guildId = channel?.guild_id ?? messageGuildId;
    return guildId ? ["servers", guildId, channelId] : ["unsorted", channelId];
}

const inScope = ([kind]: ConversationPath) =>
    kind === "dms" || kind === "groups" ? settings.store.directMessages : settings.store.servers;

/** Archives whatever messages an event carries; payload shapes vary per event, so filter at the boundary. */
function archive(messages: unknown[] | undefined) {
    const valid = messages?.flat().filter(isMessage);
    if (!valid?.length) return;

    const { saveMedia, saveFiles, maxFileSize } = settings.store;
    const conversations: Conversation[] = [];

    for (const channelMessages of Map.groupBy(valid, message => message.channel_id).values()) {
        const { channel_id, guild_id } = channelMessages[0];
        const path = conversationPath(channel_id, guild_id);
        if (!inScope(path)) continue;

        const attachments = channelMessages
            .flatMap(message => message.attachments ?? [])
            .filter(attachment => isMedia(attachment) ? saveMedia : saveFiles);
        conversations.push({ path, messages: channelMessages, attachments });
    }

    if (conversations.length) return Native.archive(conversations, maxFileSize * BYTES_PER_MB);
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

/** DMs first, then every readable server channel, limited to the kinds the scope settings archive. */
function backfillOrder(): Channel[] {
    const { directMessages, servers } = settings.store;
    const privateChannels = directMessages ? ChannelStore.getSortedPrivateChannels() : [];
    const guildChannels = !servers ? [] : GuildStore.getGuildIds().flatMap(guildId =>
        GuildChannelStore.getChannels(guildId).SELECTABLE
            .flatMap(entry => "channel" in entry ? [entry.channel] : [])
            .filter(channel => PermissionStore.can(PermissionsBits.READ_MESSAGE_HISTORY, channel))
    );
    return [...privateChannels, ...guildChannels];
}

const isRateLimit = (error: unknown) =>
    typeof error === "object" && error !== null && "status" in error && error.status === 429;

/** Fetches the page before the oldest archived message. Returns true once the channel's first message is archived. */
async function fetchOlder(channelId: string) {
    const before = await Native.oldestMessageId(conversationPath(channelId));
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
    done = new Set(await DataStore.get(DONE_KEY) ?? []);

    while (run === currentRun) {
        const now = Date.now();
        if (!session.pausedAt && now >= session.end) {
            if (session.manual) showToast({ text: "Backfill ran out of time and stopped." });
            session = nextScheduledSession(now);
        }

        const { channelId, continueAfter, manual, pausedAt } = session;
        const active = now >= session.start && !pausedAt && (manual || settings.store.autoBackfill && !WindowStore.isFocused());
        const pinned = channelId && !done.has(channelId) ? ChannelStore.getChannel(channelId) : undefined;
        const channel = active && (pinned ?? backfillOrder().find(candidate => !done.has(candidate.id)));
        if (!channel) {
            if (active && manual) {
                showToast({ text: "Backfill finished every channel.", variant: "success" });
                session = nextScheduledSession(now);
            }
            await nap(IDLE_CHECK_MS);
            continue;
        }

        try {
            if (await fetchOlder(channel.id)) done.add(channel.id);
        } catch (error) {
            if (isRateLimit(error)) {
                logger.warn("Rate limited, ending this backfill session.");
                showToast({ text: "Backfill was rate limited and stopped.", variant: "critical" });
                session = nextScheduledSession(now);
                continue;
            }
            logger.warn(`Skipping channel ${channel.id}.`, error);
            showToast({ text: "Backfill skipped a channel it couldn't load.", variant: "critical" });
            done.add(channel.id);
        }

        await DataStore.set(DONE_KEY, [...done]);

        if (channel.id === channelId && done.has(channelId) && !continueAfter) {
            showToast({ text: "Backfill finished this channel.", variant: "success" });
            session = nextScheduledSession(Date.now());
            continue;
        }
        await nap(pageWait());
    }
}

export default definePlugin({
    name: "MessageArchive",
    description: "Saves every message Discord loads to disk, deduplicated.",
    authors: [EquicordDevs.mia],
    tags: ["Chat", "Utility"],
    settings,

    settingsAboutComponent: () => (
        <Paragraph>
            Messages are written as you browse to one JSONL file per conversation, sorted into servers, dms and groups by ID. Edits are kept as new lines.
            Run /backfill start in a channel to back it up to its first message. /backfill pause and /backfill stop control a running backfill.
        </Paragraph>
    ),

    commands: [{
        name: "backfill",
        description: "Back up this channel to its first message.",
        inputType: ApplicationCommandInputType.BUILT_IN,
        options: [
            {
                name: "start",
                description: "Back up this channel to its first message, or resume a paused backfill.",
                type: ApplicationCommandOptionType.SUB_COMMAND,
                options: [{
                    name: "all",
                    description: "Continue with your other channels once this one is finished.",
                    type: ApplicationCommandOptionType.BOOLEAN,
                    required: false
                }]
            },
            {
                name: "pause",
                description: "Pause the running backfill.",
                type: ApplicationCommandOptionType.SUB_COMMAND
            },
            {
                name: "stop",
                description: "Stop the running backfill.",
                type: ApplicationCommandOptionType.SUB_COMMAND
            }
        ],
        execute([{ name, options }], ctx) {
            const now = Date.now();
            const channelId = ctx.channel.id;
            const running = session.manual && now < session.end;

            if (name === "stop") {
                if (!running) return showToast({ text: "No backfill is running." });
                session = nextScheduledSession(now);
                return showToast({ text: "Backfill stopped." });
            }

            if (name === "pause") {
                if (!running) return showToast({ text: "No backfill is running." });
                if (session.pausedAt) return showToast({ text: "Backfill is already paused." });
                session.pausedAt = now;
                return showToast({ text: "Backfill paused. Run /backfill start to resume." });
            }

            if (running && session.pausedAt) {
                session.end += now - session.pausedAt;
                session.pausedAt = undefined;
                wakeUp();
                return showToast({ text: "Backfill resumed." });
            }
            if (running) return showToast({ text: "Backfill is already running." });
            if (!inScope(conversationPath(channelId))) {
                return showToast({ text: "This kind of channel is turned off in MessageArchive settings.", variant: "critical" });
            }

            const continueAfter = findOption(options, "all", false);
            if (done.has(channelId) && !continueAfter) {
                return showToast({ text: "This channel is already backed up to its first message." });
            }

            session = { ...createSession(now, true), channelId, continueAfter };
            wakeUp();
            const then = continueAfter ? "then your other channels" : "then it stops";
            showToast({ text: `Backfilling this channel, ${then}. Runs for up to ${formatDurationMs(session.end - now, true, false)}.` });
        }
    }],

    start() {
        backfill(++currentRun);
    },

    stop() {
        currentRun++;
        wakeUp();
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
