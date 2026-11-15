/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption } from "@api/Commands";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { FormSwitch } from "@components/FormSwitch";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { EquicordDevs } from "@utils/constants";
import { sleep } from "@utils/misc";
import { useAwaiter } from "@utils/react";
import { formatDurationMs } from "@utils/text";
import definePlugin, { OptionType, PluginNative, PluginSettingComponentProps } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { ChannelStore, GuildChannelStore, GuildStore, MessageStore, moment, NavigationRouter, PermissionsBits, PermissionStore, React, ScrollerThin, SelectedChannelStore, showToast, SnowflakeUtils, SortedGuildStore, TextInput, UserStore, useState, useStateFromStores, WindowStore } from "@webpack/common";

import type { Conversation, ConversationPath, PackageChannel, RawAttachment, RawMessage } from "./native";

const Native = VencordNative.pluginHelpers.MessageArchive as PluginNative<typeof import("./native")>;

const BYTES_PER_MB = 1024 * 1024;
const FOLDER_KEYS: ["folder"] = ["folder"];
const SERVER_KEYS: ["servers", "flippedServers"] = ["servers", "flippedServers"];
const SERVER_LIST_HEIGHT = 400;
const IDLE_CHECK_MS = 30_000;
const KEY_GAP_MS = 500;
const LOAD_TIMEOUT_MS = 10_000;
/** How long the message list must hold still before keys are pressed after a jump. */
const SETTLE_MS = 1000;
const MESSAGE_LIST = "[data-list-id^=\"chat-messages\"]";
const SECOND_MS = 1000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const DONE_KEY = "MessageArchive_doneChannels";
const PACKAGE_KEY = "MessageArchive_package";
const PACKAGE_CURSOR_KEY = "MessageArchive_packageCursor";

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
let packageChannels: PackageChannel[] = [];
/** How many of each package channel's message ids backfill has already opened or found archived. */
let packageCursor: Record<string, number> = {};
/** Package channels Discord didn't open when backfill tried them, most likely because you lost access. */
const unreachable = new Set<string>();

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

function ServerSettings() {
    settings.use(SERVER_KEYS);
    const guildIds = useStateFromStores([SortedGuildStore], () => SortedGuildStore.getFlattenedGuildIds());

    function setAll(value: boolean) {
        settings.store.servers = value;
        settings.store.flippedServers = [];
    }

    return (
        <section style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <Heading>Servers</Heading>
            <FormSwitch
                title="All servers"
                description="Run /archive-server in a server to flip just that one."
                value={guildIds.every(serverInScope)}
                onChange={setAll}
            />
            <ScrollerThin style={{ maxHeight: SERVER_LIST_HEIGHT }}>
                {guildIds.map(id => (
                    <FormSwitch key={id} title={GuildStore.getGuild(id)?.name ?? id} value={serverInScope(id)} onChange={() => flipServer(id)} />
                ))}
            </ScrollerThin>
        </section>
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
        type: OptionType.COMPONENT,
        default: true,
        component: ServerSettings
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
}).withPrivateSettings<{ flippedServers?: string[]; }>();

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

/** `servers` is the default for every server, and `flippedServers` lists the servers set the other way. */
const serverInScope = (guildId: string) => settings.store.servers !== (settings.store.flippedServers ?? []).includes(guildId);

function flipServer(guildId: string) {
    const flipped = settings.store.flippedServers ?? [];
    settings.store.flippedServers = flipped.includes(guildId) ? flipped.filter(id => id !== guildId) : [...flipped, guildId];
}

const inScope = ([kind, id]: ConversationPath) =>
    kind === "dms" || kind === "groups" ? settings.store.directMessages
        : kind === "servers" ? serverInScope(id) : settings.store.servers;

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
    const privateChannels = settings.store.directMessages ? ChannelStore.getSortedPrivateChannels() : [];
    const guildChannels = GuildStore.getGuildIds().filter(serverInScope).flatMap(guildId =>
        GuildChannelStore.getChannels(guildId).SELECTABLE
            .flatMap(entry => "channel" in entry ? [entry.channel] : [])
            .filter(channel => PermissionStore.can(PermissionsBits.READ_MESSAGE_HISTORY, channel))
    );
    return [...privateChannels, ...guildChannels];
}

/** The channel backfill last opened, so it jumps to the archive's oldest message once per visit. */
let visiting: string | undefined;

/**
 * Moves one step back through a channel the way a person would, so Discord makes every request itself and the
 * flux listeners archive what it loads. The first step opens the channel at its oldest archived message, like a
 * message link. Every later step focuses the message list and presses Home, to reach the top of what's loaded, then
 * Page Up, so Discord loads the page before it. Returns true once the channel's first message is loaded.
 */
async function scrollOlder(channel: Channel) {
    if (visiting !== channel.id || SelectedChannelStore.getChannelId() !== channel.id) {
        visiting = channel.id;
        const oldest = await Native.oldestMessageId(conversationPath(channel.id));
        NavigationRouter.transitionTo(`/channels/${channel.guild_id ?? "@me"}/${channel.id}${oldest ? `/${oldest}` : ""}`);
        return false;
    }

    const { ready, hasMoreBefore } = MessageStore.getMessages(channel.id);
    if (ready && !hasMoreBefore) return true;

    await pressKeys("Home", "PageUp");
    return false;
}

/** Focuses the message list and presses each key as real input, with a short pause after each. */
async function pressKeys(...keys: string[]) {
    const list = document.querySelector<HTMLElement>(MESSAGE_LIST);
    if (!list) return;
    if (!list.hasAttribute("tabindex")) list.tabIndex = -1;
    list.focus({ preventScroll: true });

    for (const key of keys) {
        await Native.pressKey(key);
        await sleep(KEY_GAP_MS);
    }
}

/** Waits, up to a limit, until Discord shows the channel with its messages loaded, so keys land on a list. */
async function waitForChannel(channelId: string) {
    const loaded = () => {
        const { ready, loadingMore } = MessageStore.getMessages(channelId);
        return SelectedChannelStore.getChannelId() === channelId && ready && !loadingMore;
    };
    for (let waited = 0; waited < LOAD_TIMEOUT_MS && !loaded(); waited += KEY_GAP_MS) await sleep(KEY_GAP_MS);
    return loaded();
}

/** Waits, up to a limit, until the message list holds still, so keys don't cut short Discord's scroll to a linked message. */
async function waitForScrollToSettle() {
    let scroller = document.querySelector<HTMLElement>(MESSAGE_LIST)?.parentElement;
    while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    if (!scroller) return;

    let last: number | undefined;
    for (let waited = 0; waited < LOAD_TIMEOUT_MS && scroller.scrollTop !== last; waited += SETTLE_MS) {
        last = scroller.scrollTop;
        await sleep(SETTLE_MS);
    }
}

interface PackageTarget {
    channel: Channel;
    messageId: string;
    /** Position of `messageId` in its package channel's list. */
    index: number;
}

/**
 * The next `limit` messages of yours from the data package that backfill will open: ones the archive doesn't have
 * yet, in channels you can still open. Channels go one at a time, starting with `firstChannelId` when given, then the
 * one you last wrote in, each finished newest first before the next.
 */
async function upcomingPackageMessages(limit: number, firstChannelId?: string) {
    const upcoming: PackageTarget[] = [];
    const ordered = [...packageChannels].sort((a, b) => Number(b.channelId === firstChannelId) - Number(a.channelId === firstChannelId));

    for (const { channelId, guildId, messageIds } of ordered) {
        let cursor = packageCursor[channelId] ?? 0;
        const channel = ChannelStore.getChannel(channelId);
        if (cursor >= messageIds.length || !channel || unreachable.has(channelId)) continue;
        if (channel.guild_id && !PermissionStore.can(PermissionsBits.VIEW_CHANNEL | PermissionsBits.READ_MESSAGE_HISTORY, channel)) continue;

        const path = conversationPath(channelId, guildId);
        if (!inScope(path)) continue;

        while (upcoming.length < limit && cursor < messageIds.length) {
            const offset = await Native.firstUnarchived(path, messageIds.slice(cursor));
            if (offset === -1) {
                if (cursor === (packageCursor[channelId] ?? 0)) packageCursor[channelId] = messageIds.length;
                break;
            }
            cursor += offset;
            upcoming.push({ channel, messageId: messageIds[cursor], index: cursor });
            cursor++;
        }
        if (upcoming.length >= limit) break;
    }
    return upcoming;
}

/**
 * Opens the next package message the way a message link does, waits for Discord's scroll to it to finish, then
 * presses Page Down and Page Up twice, the second one to get above the message itself, so Discord also loads the
 * messages after and before it. A channel Discord won't open is passed over until the next reload. Returns false once
 * every package message you can open is archived.
 */
async function openPackageMessage(firstChannelId?: string) {
    const [next] = await upcomingPackageMessages(1, firstChannelId);
    if (!next) return false;

    const { channel, messageId, index } = next;
    visiting = undefined;
    NavigationRouter.transitionTo(`/channels/${channel.guild_id ?? "@me"}/${channel.id}/${messageId}`);

    if (!await waitForChannel(channel.id)) {
        unreachable.add(channel.id);
        return true;
    }
    packageCursor[channel.id] = index + 1;
    await DataStore.set(PACKAGE_CURSOR_KEY, packageCursor);
    await waitForScrollToSettle();
    await pressKeys("PageDown", "PageUp", "PageUp");
    return true;
}

async function loadPackage() {
    packageChannels = await DataStore.get(PACKAGE_KEY) ?? [];
    packageCursor = await DataStore.get(PACKAGE_CURSOR_KEY) ?? {};
}

async function importPackage() {
    const channels = await Native.importPackage().catch((error: Error) => {
        showToast({ text: error.message, variant: "critical" });
        return null;
    });
    if (!channels) return;
    if (!channels.length) return showToast({ text: "That data package has no messages in it.", variant: "critical" });

    packageChannels = channels;
    packageCursor = {};
    await DataStore.setMany([[PACKAGE_KEY, channels], [PACKAGE_CURSOR_KEY, {}]]);
    showToast({ text: "Data package imported. Backfill visits your messages from it first.", variant: "success" });
}

async function removePackage() {
    packageChannels = [];
    packageCursor = {};
    await DataStore.delMany([PACKAGE_KEY, PACKAGE_CURSOR_KEY]);
}

const UPCOMING_COUNT = 3;

function channelLabel(channel: Channel) {
    const recipientId = channel.isDM() && channel.getRecipientId();
    if (recipientId) return `@${UserStore.getUser(recipientId)?.username ?? "unknown user"}`;
    if (channel.isGroupDM()) return channel.name || "Group DM";
    return `#${channel.name} in ${GuildStore.getGuild(channel.guild_id)?.name ?? "an unknown server"}`;
}

function PackageSettings() {
    const [version, setVersion] = useState(0);
    const [upcoming, , pending] = useAwaiter(async () => {
        if (!packageChannels.length) await loadPackage();
        return upcomingPackageMessages(UPCOMING_COUNT);
    }, { fallbackValue: [], deps: [version] });

    const act = (action: () => Promise<unknown>) => () => action().then(() => setVersion(v => v + 1));
    const total = packageChannels.reduce((sum, { messageIds }) => sum + messageIds.length, 0);

    return (
        <section style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <Heading>Data package</Heading>
            {packageChannels.length ? (
                <>
                    <Paragraph>{total.toLocaleString()} of your messages from {packageChannels.length.toLocaleString()} channels. Backfill opens the ones that aren't archived yet first, newest first.</Paragraph>
                    <Paragraph>
                        {pending ? "Finding the next messages…" : upcoming.length ? "Up next:" : "Every message you can still open is archived."}
                    </Paragraph>
                    {!pending && upcoming.map(({ channel, messageId }) => (
                        <Paragraph key={messageId}>
                            {channelLabel(channel)}, {moment(SnowflakeUtils.extractTimestamp(messageId)).format("LLL")}
                        </Paragraph>
                    ))}
                </>
            ) : (
                <Paragraph>Import your Discord data package and backfill first opens each message of yours that isn't archived yet, newest first, so the conversation around it gets saved.</Paragraph>
            )}
            <div style={{ display: "flex", gap: "8px" }}>
                <Button size="small" onClick={act(importPackage)}>{packageChannels.length ? "Replace data package" : "Import data package"}</Button>
                {packageChannels.length > 0 && <Button size="small" variant="secondary" onClick={act(removePackage)}>Remove</Button>}
            </div>
        </section>
    );
}

/** Pages back through unfinished channels during sessions. Scheduled sessions pause while Discord is focused. */
async function backfill(run: number) {
    session = nextScheduledSession(Date.now());
    done = new Set(await DataStore.get(DONE_KEY) ?? []);
    await loadPackage();

    while (run === currentRun) {
        const now = Date.now();
        if (!session.pausedAt && now >= session.end) {
            if (session.manual) showToast({ text: "Backfill ran out of time and stopped." });
            session = nextScheduledSession(now);
        }
        if (session.channelId && !inScope(conversationPath(session.channelId))) {
            showToast({ text: "Backfill stopped because this channel is no longer archived." });
            session = nextScheduledSession(now);
        }

        const { channelId, continueAfter, manual, pausedAt } = session;
        const active = now >= session.start && !pausedAt && (manual || settings.store.autoBackfill && !WindowStore.isFocused());
        const pinned = channelId && !done.has(channelId) ? ChannelStore.getChannel(channelId) : undefined;
        if (active && await openPackageMessage(channelId)) {
            await nap(pageWait());
            continue;
        }
        const channel = active && (pinned ?? backfillOrder().find(candidate => !done.has(candidate.id)));
        if (!channel) {
            if (active && manual) {
                showToast({ text: "Backfill finished every channel.", variant: "success" });
                session = nextScheduledSession(now);
            }
            await nap(IDLE_CHECK_MS);
            continue;
        }

        if (manual && visiting === channel.id && SelectedChannelStore.getChannelId() !== channel.id) {
            session.pausedAt = now;
            showToast({ text: "Backfill paused because you left the channel. Run /backfill start to resume." });
            continue;
        }

        if (await scrollOlder(channel)) {
            done.add(channel.id);
            await DataStore.set(DONE_KEY, [...done]);
        }

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
        <section style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <Paragraph>
                Messages are written as you browse to one JSONL file per conversation, sorted into servers, dms and groups by ID. Edits are kept as new lines.
                Run /backfill start in a channel to back it up to its first message. /backfill pause and /backfill stop control a running backfill.
            </Paragraph>
            <PackageSettings />
        </section>
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
                visiting = undefined;
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
            visiting = undefined;
            wakeUp();
            const then = continueAfter ? "then your other channels" : "then it stops";
            showToast({ text: `Backfilling this channel, ${then}. Runs for up to ${formatDurationMs(session.end - now, true, false)}.` });
        }
    }, {
        name: "archive-server",
        description: "Turn archiving on or off for this server.",
        inputType: ApplicationCommandInputType.BUILT_IN,
        execute(_, ctx) {
            const guildId = ctx.guild?.id;
            if (!guildId) return showToast({ text: "Run this in a server." });

            flipServer(guildId);
            showToast({ text: serverInScope(guildId) ? "This server is archived now." : "This server is no longer archived." });
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
