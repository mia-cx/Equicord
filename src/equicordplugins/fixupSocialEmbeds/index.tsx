/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { MessageObject } from "@api/MessageEvents";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { TextInput } from "@webpack/common";

interface HostReplacement {
    inputHost: string;
    outputHost: string;
}

const DEFAULT_REPLACEMENTS: HostReplacement[] = [
    { inputHost: "x.com", outputHost: "fixupx.com" },
    { inputHost: "instagram.com", outputHost: "hhinstagram.com" }
];

const URL_REGEX = /(https?:\/\/[^\s<]+[^<.,:;"'>)|\]\s])/gi;
const SETTINGS_KEYS: Array<"hostReplacements"> = ["hostReplacements"];

function normalizeHost(value: string): string {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return "";

    try {
        return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname;
    } catch {
        return trimmed.replace(/^\.+|\.+$/g, "");
    }
}

function replaceUrlHost(value: string, replacements: HostReplacement[]): string {
    let url: URL;

    try {
        url = new URL(value);
    } catch {
        return value;
    }

    const currentHost = url.hostname.toLowerCase();
    const replacement = replacements.find(rule =>
        normalizeHost(rule.inputHost) === currentHost
        && normalizeHost(rule.outputHost)
    );

    if (!replacement) return value;

    url.hostname = normalizeHost(replacement.outputHost);
    return url.toString();
}

export function replaceSocialHosts(content: string, replacements: HostReplacement[]): string {
    if (!/https?:\/\//i.test(content)) return content;
    return content.replace(URL_REGEX, url => replaceUrlHost(url, replacements));
}

function HostReplacementSettings() {
    const { hostReplacements } = settings.use(SETTINGS_KEYS);

    const update = (index: number, key: keyof HostReplacement, value: string) => {
        const next = hostReplacements.map((rule, ruleIndex) =>
            ruleIndex === index ? { ...rule, [key]: value } : rule
        );
        settings.store.hostReplacements = next;
    };

    const remove = (index: number) => {
        settings.store.hostReplacements = hostReplacements.filter((_, ruleIndex) => ruleIndex !== index);
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <Paragraph>
                Replace URL hosts immediately before messages are sent or edited. Enter hostnames only;
                paths, query parameters, and fragments are preserved.
            </Paragraph>

            {hostReplacements.map((rule, index) => (
                <div
                    key={index}
                    style={{
                        display: "grid",
                        gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr) auto",
                        gap: "8px",
                        alignItems: "center"
                    }}
                >
                    <TextInput
                        value={rule.inputHost}
                        placeholder="x.com"
                        aria-label={`Input host ${index + 1}`}
                        spellCheck={false}
                        onChange={value => update(index, "inputHost", value)}
                    />
                    <TextInput
                        value={rule.outputHost}
                        placeholder="fixupx.com"
                        aria-label={`Output host ${index + 1}`}
                        spellCheck={false}
                        onChange={value => update(index, "outputHost", value)}
                    />
                    <Button
                        variant="dangerPrimary"
                        size="small"
                        onClick={() => remove(index)}
                    >
                        Remove
                    </Button>
                </div>
            ))}

            {!hostReplacements.length && (
                <Paragraph>No host replacements configured.</Paragraph>
            )}

            <Button
                size="small"
                onClick={() => {
                    settings.store.hostReplacements = [
                        ...hostReplacements,
                        { inputHost: "", outputHost: "" }
                    ];
                }}
            >
                Add replacement
            </Button>
        </div>
    );
}

const settings = definePluginSettings({
    replacements: {
        type: OptionType.COMPONENT,
        description: "Configure URL host replacements.",
        component: HostReplacementSettings
    },
    hostReplacements: {
        type: OptionType.CUSTOM,
        description: "The input and output hosts used to fix social media embeds.",
        default: DEFAULT_REPLACEMENTS
    }
});

function fixMessage(message: MessageObject): void {
    message.content = replaceSocialHosts(message.content, settings.store.hostReplacements);
}

export default definePlugin({
    name: "FixupSocialEmbeds",
    description: "Replaces social media URL hosts with embed-friendly alternatives before sending.",
    authors: [EquicordDevs.mia],
    tags: ["Chat", "Utility"],
    dependencies: ["MessageEventsAPI"],
    settings,

    onBeforeMessageSend(_channelId, message) {
        fixMessage(message);
    },

    onBeforeMessageEdit(_channelId, _messageId, message) {
        fixMessage(message);
    }
});
