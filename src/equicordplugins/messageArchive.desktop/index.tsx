/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType, PluginNative, PluginSettingComponentProps } from "@utils/types";
import { ChannelStore } from "@webpack/common";

import type { Conversation, ConversationPath, RawAttachment, RawMessage } from "./native";

const Native = VencordNative.pluginHelpers.MessageArchive as PluginNative<typeof import("./native")>;

const BYTES_PER_MB = 1024 * 1024;
const FOLDER_KEYS: ["folder"] = ["folder"];

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
    }
});

const isMessage = (value: unknown): value is RawMessage =>
    typeof value === "object" && value !== null
    && "id" in value && "channel_id" in value && "author" in value;

const isMedia = ({ content_type }: RawAttachment) => /^(image|video)\//.test(content_type ?? "");

/** Servers nest channels under the guild, DMs are named after the other user. Channels Discord hasn't loaded go to `unsorted`. */
function conversationPath({ channel_id, guild_id }: RawMessage): ConversationPath {
    const channel = ChannelStore.getChannel(channel_id);
    if (channel?.isDM()) return ["dms", channel.getRecipientId() ?? channel_id];
    if (channel?.isGroupDM()) return ["groups", channel_id];

    const guildId = channel?.guild_id ?? guild_id;
    return guildId ? ["servers", guildId, channel_id] : ["unsorted", channel_id];
}

/** Archives whatever messages an event carries; payload shapes vary per event, so filter at the boundary. */
function archive(messages: unknown[] | undefined) {
    const valid = messages?.flat().filter(isMessage);
    if (!valid?.length) return;

    const { directMessages, servers, saveMedia, saveFiles, maxFileSize } = settings.store;
    const conversations: Conversation[] = [];

    for (const channelMessages of Map.groupBy(valid, message => message.channel_id).values()) {
        const path = conversationPath(channelMessages[0]);
        const isPrivate = path[0] === "dms" || path[0] === "groups";
        if (!(isPrivate ? directMessages : servers)) continue;

        const attachments = channelMessages
            .flatMap(message => message.attachments ?? [])
            .filter(attachment => isMedia(attachment) ? saveMedia : saveFiles);
        conversations.push({ path, messages: channelMessages, attachments });
    }

    if (conversations.length) Native.archive(conversations, maxFileSize * BYTES_PER_MB);
}

export default definePlugin({
    name: "MessageArchive",
    description: "Saves every message Discord loads to disk, deduplicated. Makes no requests of its own unless you turn on attachment downloads.",
    authors: [EquicordDevs.mia],
    tags: ["Chat", "Utility"],
    settings,

    settingsAboutComponent: () => (
        <Paragraph>
            Messages are written as you browse to one JSONL file per conversation, sorted into servers, dms and groups by ID. Edits are kept as new lines.
        </Paragraph>
    ),

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
