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

import type { ArchivedAttachment, RawAttachment, RawMessage } from "./native";

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

/** Archives whatever messages an event carries; payload shapes vary per event, so filter at the boundary. */
function archive(messages: unknown[] | undefined) {
    const { directMessages, servers, saveMedia, saveFiles, maxFileSize } = settings.store;

    const valid = messages?.flat().filter(isMessage).filter(message =>
        ChannelStore.getChannel(message.channel_id)?.isPrivate() ? directMessages : servers
    );
    if (!valid?.length) return;

    const attachments: ArchivedAttachment[] = valid.flatMap(({ channel_id, attachments = [] }) => attachments
        .filter(attachment => isMedia(attachment) ? saveMedia : saveFiles)
        .map(attachment => ({ ...attachment, channel_id }))
    );

    Native.archive(valid, attachments, maxFileSize * BYTES_PER_MB);
}

export default definePlugin({
    name: "MessageArchive",
    description: "Saves every message Discord loads to disk, deduplicated. Makes no requests of its own unless you turn on attachment downloads.",
    authors: [EquicordDevs.mia],
    tags: ["Chat", "Utility"],
    settings,

    settingsAboutComponent: () => (
        <Paragraph>
            Messages are written to one JSONL file per channel as you browse. Edits are kept as new lines.
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
