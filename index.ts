/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import {
    ApplicationStreamingStore,
    FluxDispatcher,
    SelectedChannelStore,
    UserStore
} from "@webpack/common";

interface DiscordStream {
    channelId: string;
    guildId: string | null;
    ownerId: string;
    streamType: string;
}

const settings = definePluginSettings({
    userIds: {
        type: OptionType.STRING,
        description: "Optional comma-separated Discord user IDs. Leave empty to watch anyone in your current voice channel.",
        default: "",
        onChange: () => resetAndScan()
    },
    streamMode: {
        type: OptionType.SELECT,
        description: "What to do when more than one person streams",
        options: [
            {
                label: "Focus newest (keep all playing)",
                value: "focus-newest",
                default: true
            },
            {
                label: "Watch all (keep current focus)",
                value: "watch-all"
            },
            {
                label: "Replace current with newest",
                value: "replace"
            }
        ],
        onChange: () => resetAndScan()
    }
});

const watchedStreamKeys = new Set<string>();
let scanTimer: ReturnType<typeof setTimeout> | undefined;
let lastChannelId: string | undefined;
let focusedStreamKey: string | undefined;

function getStreamKey(stream: DiscordStream): string {
    return stream.streamType === "guild"
        ? [stream.streamType, stream.guildId, stream.channelId, stream.ownerId].join(":")
        : [stream.streamType, stream.channelId, stream.ownerId].join(":");
}

function getAllowedUserIds(): Set<string> {
    return new Set(
        settings.store.userIds
            .split(",")
            .map(id => id.trim())
            .filter(Boolean)
    );
}

function scanForStreams() {
    scanTimer = undefined;

    const currentChannelId = SelectedChannelStore.getVoiceChannelId();

    if (currentChannelId !== lastChannelId) {
        watchedStreamKeys.clear();
        focusedStreamKey = undefined;
        lastChannelId = currentChannelId;
    }

    const activeStreams = currentChannelId
        ? ApplicationStreamingStore.getAllApplicationStreamsForChannel(currentChannelId) as DiscordStream[]
        : [];
    const activeStreamKeys = new Set(activeStreams.map(getStreamKey));

    for (const streamKey of watchedStreamKeys) {
        if (!activeStreamKeys.has(streamKey)) watchedStreamKeys.delete(streamKey);
    }

    if (!currentChannelId) {
        watchedStreamKeys.clear();
        focusedStreamKey = undefined;
        return;
    }

    const currentUserId = UserStore.getCurrentUser()?.id;
    if (!currentUserId) return;

    const allowedUserIds = getAllowedUserIds();
    const streamsInChannel = activeStreams.filter(stream =>
        stream.ownerId !== currentUserId &&
        (allowedUserIds.size === 0 || allowedUserIds.has(stream.ownerId))
    );

    for (const stream of streamsInChannel) {
        const streamKey = getStreamKey(stream);
        if (watchedStreamKeys.has(streamKey)) continue;

        // Mark first because dispatching STREAM_WATCH synchronously updates stores.
        const hadWatchedStream = watchedStreamKeys.size > 0;
        watchedStreamKeys.add(streamKey);

        FluxDispatcher.dispatch({
            type: "STREAM_WATCH",
            streamKey,
            allowMultiple: settings.store.streamMode !== "replace"
        });

        const shouldFocus = settings.store.streamMode !== "watch-all" || !hadWatchedStream;
        if (shouldFocus) {
            FluxDispatcher.dispatch({
                type: "CHANNEL_RTC_SELECT_PARTICIPANT",
                channelId: currentChannelId,
                id: streamKey
            });
            focusedStreamKey = streamKey;
        }
    }

    // If the focused streamer stopped, fall back to the most recently started
    // eligible stream that is still running.
    if (focusedStreamKey && !activeStreamKeys.has(focusedStreamKey) && streamsInChannel.length > 0) {
        const fallbackStream = streamsInChannel.at(-1)!;
        const fallbackStreamKey = getStreamKey(fallbackStream);

        // Replace mode disconnected older streams, so reconnect before focusing.
        if (settings.store.streamMode === "replace") {
            FluxDispatcher.dispatch({
                type: "STREAM_WATCH",
                streamKey: fallbackStreamKey,
                allowMultiple: false
            });
        }

        FluxDispatcher.dispatch({
            type: "CHANNEL_RTC_SELECT_PARTICIPANT",
            channelId: currentChannelId,
            id: fallbackStreamKey
        });
        watchedStreamKeys.add(fallbackStreamKey);
        focusedStreamKey = fallbackStreamKey;
    } else if (streamsInChannel.length === 0) {
        focusedStreamKey = undefined;
    }
}

function scheduleScan(delay = 100) {
    if (scanTimer !== undefined) clearTimeout(scanTimer);
    scanTimer = setTimeout(scanForStreams, delay);
}

function resetAndScan() {
    watchedStreamKeys.clear();
    focusedStreamKey = undefined;
    scheduleScan(0);
}

export default definePlugin({
    name: "AutoJoinStream",
    description: "Automatically watches a stream when someone starts streaming in your current voice channel.",
    tags: ["Utility", "Voice"],
    authors: [{ name: "AutoJoinStream contributors", id: 0n }],
    settings,

    start() {
        ApplicationStreamingStore.addChangeListener(scheduleScan);
        SelectedChannelStore.addChangeListener(scheduleScan);
        scheduleScan(0);
    },

    stop() {
        ApplicationStreamingStore.removeChangeListener(scheduleScan);
        SelectedChannelStore.removeChangeListener(scheduleScan);
        if (scanTimer !== undefined) clearTimeout(scanTimer);
        scanTimer = undefined;
        watchedStreamKeys.clear();
        focusedStreamKey = undefined;
        lastChannelId = undefined;
    }
});
