/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import {
    ApplicationStreamingStore,
    ChannelStore,
    FluxDispatcher,
    SelectedChannelStore,
    showToast,
    Toasts,
    UserStore
} from "@webpack/common";

type StreamMode = "focus-newest" | "watch-all" | "replace";
type DisplayMode = "normal" | "grid" | "fullscreen" | "popout";

interface DiscordStream {
    channelId: string;
    guildId: string | null;
    ownerId: string;
    streamType: "guild" | "call";
}

interface StreamEntry {
    key: string;
    stream: DiscordStream;
}

const logger = new Logger("AutoJoinStream");

const settings = definePluginSettings({
    streamMode: {
        type: OptionType.SELECT,
        description: "What to do when more than one person streams",
        options: [
            { label: "Focus newest (keep all playing)", value: "focus-newest", default: true },
            { label: "Watch all (keep current focus)", value: "watch-all" },
            { label: "Replace current with newest", value: "replace" }
        ],
        onChange: () => resetAndScan()
    },
    displayMode: {
        type: OptionType.SELECT,
        description: "How to display an automatically focused stream",
        options: [
            { label: "Normal focus", value: "normal", default: true },
            { label: "Side-by-side grid", value: "grid" },
            { label: "Fullscreen", value: "fullscreen" },
            { label: "Pop-out window", value: "popout" }
        ],
        onChange: () => applyCurrentDisplayMode()
    },
    showOwnStreamInGrid: {
        type: OptionType.BOOLEAN,
        description: "Show your own screen share as a tile in side-by-side grid mode",
        default: false,
        onChange: () => applyCurrentDisplayMode()
    },
    switchDelay: {
        type: OptionType.SLIDER,
        description: "Seconds to wait before handling a new stream",
        markers: [0, 1, 2, 3, 5, 10],
        default: 0,
        stickToMarkers: true
    },
    switchCooldown: {
        type: OptionType.SLIDER,
        description: "Minimum seconds between automatic focus changes",
        markers: [0, 2, 5, 10, 15, 30],
        default: 0,
        stickToMarkers: true
    },
    pauseOnManualFocus: {
        type: OptionType.BOOLEAN,
        description: "Lock automatic focus after you manually select a different stream",
        default: true
    },
    notifications: {
        type: OptionType.BOOLEAN,
        description: "Show notifications when watching, switching, locking, or encountering an error",
        default: true
    },
    userIds: {
        type: OptionType.STRING,
        description: "Allowed user IDs, comma-separated. Empty allows everyone",
        default: "",
        onChange: () => resetAndScan()
    },
    blockedUserIds: {
        type: OptionType.STRING,
        description: "Blocked user IDs, comma-separated",
        default: "",
        onChange: () => resetAndScan()
    },
    priorityUserIds: {
        type: OptionType.STRING,
        description: "Priority user IDs in highest-to-lowest order, comma-separated",
        default: "",
        onChange: () => resetAndScan()
    },
    allowedGuildIds: {
        type: OptionType.STRING,
        description: "Allowed server IDs, comma-separated. Empty allows every server",
        default: "",
        onChange: () => resetAndScan()
    },
    blockedGuildIds: {
        type: OptionType.STRING,
        description: "Blocked server IDs, comma-separated",
        default: "",
        onChange: () => resetAndScan()
    },
    allowedChannelIds: {
        type: OptionType.STRING,
        description: "Allowed voice channel IDs, comma-separated. Empty allows every channel",
        default: "",
        onChange: () => resetAndScan()
    },
    blockedChannelIds: {
        type: OptionType.STRING,
        description: "Blocked voice channel IDs, comma-separated",
        default: "",
        onChange: () => resetAndScan()
    }
});

const knownStreamKeys = new Set<string>();
const streamOrder = new Map<string, number>();
const focusHistory: string[] = [];
const selfStreamsHiddenByPlugin = new Set<string>();

let scanTimer: ReturnType<typeof setTimeout> | undefined;
let lastChannelId: string | undefined;
let focusedStreamKey: string | undefined;
let sequence = 0;
let sessionLocked = false;
let internalSelection = false;
let lastAutoFocusAt = 0;
let compatible = true;
let lastError: string | undefined;
let errorToastShown = false;

function parseIds(value: string): string[] {
    return [...new Set(value.split(",").map(id => id.trim()).filter(Boolean))];
}

function getStreamKey(stream: DiscordStream): string {
    return stream.streamType === "guild"
        ? [stream.streamType, stream.guildId, stream.channelId, stream.ownerId].join(":")
        : [stream.streamType, stream.channelId, stream.ownerId].join(":");
}

function getDisplayName(userId: string): string {
    const user = UserStore.getUser(userId);
    return user?.globalName || user?.username || userId;
}

function notify(message: string, type = Toasts.Type.MESSAGE) {
    if (settings.store.notifications) showToast(message, type);
}

function fail(error: unknown) {
    compatible = false;
    lastError = error instanceof Error ? error.message : String(error);
    logger.error("Discord stream integration failed", error);
    if (!errorToastShown) {
        errorToastShown = true;
        notify(`AutoJoinStream compatibility error: ${lastError}`, Toasts.Type.FAILURE);
    }
}

function dispatch(action: { type: string; } & Record<string, unknown>): boolean {
    try {
        FluxDispatcher.dispatch(action as Parameters<typeof FluxDispatcher.dispatch>[0]);
        return true;
    } catch (error) {
        fail(error);
        return false;
    }
}

function validateCompatibility(): boolean {
    const store = ApplicationStreamingStore as typeof ApplicationStreamingStore & {
        getAllApplicationStreamsForChannel?: (channelId: string) => DiscordStream[];
    };

    if (typeof store.getAllApplicationStreamsForChannel !== "function") {
        fail(new Error("ApplicationStreamingStore.getAllApplicationStreamsForChannel is unavailable"));
        return false;
    }

    compatible = true;
    lastError = undefined;
    errorToastShown = false;
    return true;
}

function isEligible(stream: DiscordStream): boolean {
    const allowedUsers = parseIds(settings.store.userIds);
    const blockedUsers = parseIds(settings.store.blockedUserIds);
    const allowedGuilds = parseIds(settings.store.allowedGuildIds);
    const blockedGuilds = parseIds(settings.store.blockedGuildIds);
    const allowedChannels = parseIds(settings.store.allowedChannelIds);
    const blockedChannels = parseIds(settings.store.blockedChannelIds);

    if (stream.ownerId === UserStore.getCurrentUser()?.id) return false;
    if (allowedUsers.length > 0 && !allowedUsers.includes(stream.ownerId)) return false;
    if (blockedUsers.includes(stream.ownerId)) return false;
    if (allowedGuilds.length > 0 && (!stream.guildId || !allowedGuilds.includes(stream.guildId))) return false;
    if (stream.guildId && blockedGuilds.includes(stream.guildId)) return false;
    if (allowedChannels.length > 0 && !allowedChannels.includes(stream.channelId)) return false;
    if (blockedChannels.includes(stream.channelId)) return false;
    return true;
}

function getEntries(channelId: string): StreamEntry[] {
    try {
        return (ApplicationStreamingStore.getAllApplicationStreamsForChannel(channelId) as DiscordStream[])
            .filter(isEligible)
            .map(stream => ({ key: getStreamKey(stream), stream }));
    } catch (error) {
        fail(error);
        return [];
    }
}

function rememberFocus(streamKey: string) {
    const oldIndex = focusHistory.indexOf(streamKey);
    if (oldIndex !== -1) focusHistory.splice(oldIndex, 1);
    focusHistory.push(streamKey);
    focusedStreamKey = streamKey;
}

function getPriorityRank(entry: StreamEntry): number {
    const index = parseIds(settings.store.priorityUserIds).indexOf(entry.stream.ownerId);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function pickPreferred(entries: StreamEntry[], oldest = false): StreamEntry | undefined {
    return entries.toSorted((a, b) => {
        const priorityDifference = getPriorityRank(a) - getPriorityRank(b);
        if (priorityDifference !== 0) return priorityDifference;
        const orderDifference = (streamOrder.get(a.key) ?? 0) - (streamOrder.get(b.key) ?? 0);
        return oldest ? orderDifference : -orderDifference;
    })[0];
}

function pickHistoryFallback(entries: StreamEntry[]): StreamEntry | undefined {
    for (let i = focusHistory.length - 1; i >= 0; i--) {
        const entry = entries.find(candidate => candidate.key === focusHistory[i]);
        if (entry) return entry;
    }
    return pickPreferred(entries, settings.store.streamMode === "watch-all");
}

function watch(entry: StreamEntry, allowMultiple: boolean): boolean {
    return dispatch({ type: "STREAM_WATCH", streamKey: entry.key, allowMultiple });
}

function setOwnStreamHidden(channelId: string, hidden: boolean) {
    if (hidden) {
        if (!ApplicationStreamingStore.isSelfStreamHidden(channelId)) {
            dispatch({ type: "STREAM_UPDATE_SELF_HIDDEN", channelId, selfStreamHidden: true });
            selfStreamsHiddenByPlugin.add(channelId);
        }
    } else if (selfStreamsHiddenByPlugin.delete(channelId)) {
        dispatch({ type: "STREAM_UPDATE_SELF_HIDDEN", channelId, selfStreamHidden: false });
    }
}

function applyDisplayMode(channelId: string, streamKey: string) {
    const displayMode = settings.store.displayMode as DisplayMode;
    const channel = ChannelStore.getChannel(channelId);
    const defaultLayout = channel?.isGuildVocalOrThread() ? "no-chat" : "normal";

    if (displayMode === "fullscreen") {
        setOwnStreamHidden(channelId, false);
        dispatch({ type: "CHANNEL_RTC_UPDATE_LAYOUT", channelId, layout: "full-screen", appContext: "APP" });
    } else if (displayMode === "popout") {
        setOwnStreamHidden(channelId, false);
        dispatch({ type: "CALL_TILE_POPOUT_WINDOW_OPEN", channelId, participantId: streamKey });
    } else if (displayMode === "grid") {
        setOwnStreamHidden(channelId, !settings.store.showOwnStreamInGrid);
        dispatch({ type: "CHANNEL_RTC_UPDATE_LAYOUT", channelId, layout: defaultLayout, appContext: "APP" });
        dispatch({ type: "CHANNEL_RTC_SELECT_PARTICIPANT", channelId, id: null });
    } else {
        setOwnStreamHidden(channelId, false);
        dispatch({ type: "CHANNEL_RTC_UPDATE_LAYOUT", channelId, layout: defaultLayout, appContext: "APP" });
    }
}

function applyCurrentDisplayMode() {
    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (channelId && focusedStreamKey) applyDisplayMode(channelId, focusedStreamKey);
}

function focus(entry: StreamEntry, reason: "new" | "fallback" | "command"): boolean {
    const now = Date.now();
    const cooldownRemaining = settings.store.switchCooldown * 1000 - (now - lastAutoFocusAt);
    if (reason !== "command" && cooldownRemaining > 0) {
        scheduleScan(cooldownRemaining);
        return false;
    }

    internalSelection = true;
    const selected = dispatch({
        type: "CHANNEL_RTC_SELECT_PARTICIPANT",
        channelId: entry.stream.channelId,
        id: entry.key
    });
    internalSelection = false;
    if (!selected) return false;

    rememberFocus(entry.key);
    lastAutoFocusAt = now;
    applyDisplayMode(entry.stream.channelId, entry.key);
    notify(`${reason === "fallback" ? "Returned to" : "Watching"} ${getDisplayName(entry.stream.ownerId)}'s stream`);
    return true;
}

function scanForStreams() {
    scanTimer = undefined;
    if (!compatible) return;

    const currentChannelId = SelectedChannelStore.getVoiceChannelId();
    if (currentChannelId !== lastChannelId) {
        if (lastChannelId) setOwnStreamHidden(lastChannelId, false);
        clearRuntimeState();
        lastChannelId = currentChannelId;
    }
    if (!currentChannelId) return;

    const entries = getEntries(currentChannelId);
    const activeKeys = new Set(entries.map(entry => entry.key));

    for (const key of knownStreamKeys) {
        if (!activeKeys.has(key)) {
            knownStreamKeys.delete(key);
            streamOrder.delete(key);
        }
    }
    for (let i = focusHistory.length - 1; i >= 0; i--) {
        if (!activeKeys.has(focusHistory[i])) focusHistory.splice(i, 1);
    }

    const newEntries = entries.filter(entry => !knownStreamKeys.has(entry.key));
    for (const entry of newEntries) {
        knownStreamKeys.add(entry.key);
        streamOrder.set(entry.key, ++sequence);
    }

    const mode = settings.store.streamMode as StreamMode;
    if (mode !== "replace") {
        for (const entry of newEntries) watch(entry, true);
    }

    const focusedIsActive = !!focusedStreamKey && activeKeys.has(focusedStreamKey);
    let target: StreamEntry | undefined;
    let reason: "new" | "fallback" = "new";

    if (!focusedIsActive && entries.length > 0) {
        target = pickHistoryFallback(entries);
        reason = focusedStreamKey ? "fallback" : "new";
    } else if (mode !== "watch-all") {
        target = pickPreferred(entries);
    }

    if (!target || sessionLocked || target.key === focusedStreamKey) return;
    if (mode === "replace" && !watch(target, false)) return;
    focus(target, reason);
}

function getConfiguredDelayMs(): number {
    return settings.store.switchDelay * 1000;
}

function scheduleScan(delay = getConfiguredDelayMs()) {
    if (scanTimer !== undefined) return;
    scanTimer = setTimeout(scanForStreams, Math.max(0, delay));
}

function resetAndScan() {
    clearRuntimeState();
    if (scanTimer !== undefined) clearTimeout(scanTimer);
    scanTimer = undefined;
    scheduleScan(0);
}

function clearRuntimeState() {
    knownStreamKeys.clear();
    streamOrder.clear();
    focusHistory.length = 0;
    focusedStreamKey = undefined;
    sequence = 0;
}

function setLocked(locked: boolean, announce = true) {
    sessionLocked = locked;
    if (announce) notify(`AutoJoinStream focus ${locked ? "locked" : "unlocked"}`);
    if (!locked) scheduleScan(0);
}

function getStatus(): string {
    const channelId = SelectedChannelStore.getVoiceChannelId();
    return [
        `**AutoJoinStream:** ${compatible ? "compatible" : "compatibility error"}`,
        `**Mode:** ${settings.store.streamMode}`,
        `**Display:** ${settings.store.displayMode}`,
        `**Focus lock:** ${sessionLocked ? "locked" : "unlocked"}`,
        `**Voice channel:** ${channelId ?? "not connected"}`,
        `**Detected streams:** ${knownStreamKeys.size}`,
        lastError ? `**Last error:** ${lastError}` : null
    ].filter(Boolean).join("\n");
}

export default definePlugin({
    name: "AutoJoinStream",
    description: "Automatically watches, prioritises, and switches between streams in your current voice channel.",
    tags: ["Commands", "Utility", "Voice"],
    authors: [{ name: "Blacksheep-25", id: 130476807542669312n }],
    settings,

    commands: [{
        name: "autostream",
        description: "Control AutoJoinStream",
        inputType: ApplicationCommandInputType.BUILT_IN,
        options: [
            { name: "lock", description: "Temporarily stop automatic focus changes", type: ApplicationCommandOptionType.SUB_COMMAND },
            { name: "unlock", description: "Resume automatic focus changes", type: ApplicationCommandOptionType.SUB_COMMAND },
            { name: "status", description: "Show plugin status and compatibility", type: ApplicationCommandOptionType.SUB_COMMAND },
            {
                name: "mode",
                description: "Change multi-stream behavior",
                type: ApplicationCommandOptionType.SUB_COMMAND,
                options: [{
                    name: "value",
                    description: "Stream mode",
                    type: ApplicationCommandOptionType.STRING,
                    required: true,
                    choices: [
                        { name: "Focus newest", label: "Focus newest", value: "focus-newest" },
                        { name: "Watch all", label: "Watch all", value: "watch-all" },
                        { name: "Replace current", label: "Replace current", value: "replace" }
                    ]
                }]
            }
        ],
        execute(args, ctx) {
            const subcommand = args[0];
            if (subcommand.name === "lock") setLocked(true);
            else if (subcommand.name === "unlock") setLocked(false);
            else if (subcommand.name === "mode") {
                settings.store.streamMode = findOption(subcommand.options, "value", "focus-newest") as StreamMode;
                resetAndScan();
            }
            sendBotMessage(ctx.channel.id, { content: getStatus() });
        }
    }],

    flux: {
        CHANNEL_RTC_SELECT_PARTICIPANT({ id }: { id: string | null; }) {
            if (internalSelection) return;
            if (id?.startsWith("guild:") || id?.startsWith("call:")) {
                rememberFocus(id);
                if (settings.store.pauseOnManualFocus && knownStreamKeys.size > 0) setLocked(true);
            }
        },
        STREAM_TIMED_OUT({ streamKey }: { streamKey: string; }) {
            if (knownStreamKeys.has(streamKey)) notify("A watched stream timed out", Toasts.Type.FAILURE);
        }
    },

    start() {
        validateCompatibility();
        ApplicationStreamingStore.addChangeListener(scheduleScan);
        SelectedChannelStore.addChangeListener(scheduleScan);
        scheduleScan(0);
    },

    stop() {
        ApplicationStreamingStore.removeChangeListener(scheduleScan);
        SelectedChannelStore.removeChangeListener(scheduleScan);
        if (scanTimer !== undefined) clearTimeout(scanTimer);
        scanTimer = undefined;
        for (const channelId of selfStreamsHiddenByPlugin) {
            dispatch({ type: "STREAM_UPDATE_SELF_HIDDEN", channelId, selfStreamHidden: false });
        }
        selfStreamsHiddenByPlugin.clear();
        clearRuntimeState();
        lastChannelId = undefined;
        sessionLocked = false;
    }
});
