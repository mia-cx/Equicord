/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { PluginNative } from "@utils/types";

import type { RawMessage } from "./native";

const Native = VencordNative.pluginHelpers.MessageArchive as PluginNative<typeof import("./native")>;

const isMessage = (value: unknown): value is RawMessage =>
    typeof value === "object" && value !== null
    && "id" in value && "channel_id" in value && "author" in value;

/** Archives whatever messages an event carries; payload shapes vary per event, so filter at the boundary. */
function archive(messages: unknown[] | undefined) {
    const valid = messages?.flat().filter(isMessage);
    if (valid?.length) Native.archive(valid);
}

export default definePlugin({
    name: "MessageArchive",
    description: "Saves every message Discord loads to disk, deduplicated. Makes no requests of its own.",
    authors: [EquicordDevs.mia],
    tags: ["Chat", "Utility"],

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
