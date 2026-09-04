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
    ChannelRTCStore,
    ChannelStore,
    FluxDispatcher,
    MediaEngineStore,
    SelectedChannelStore,
    showToast,
    Toasts,
    UserStore
} from "@webpack/common";

type StreamMode = "focus-newest" | "watch-all" | "replace";
type DisplayMode = "normal" | "auto" | "grid" | "fullscreen" | "popout";
type ConcreteDisplayMode = Exclude<DisplayMode, "auto">;

interface ManagedStreamVolume {
    applied: number;
    previous: number;
}

interface ManagedLayout {
    applied: string;
    previous: string;
}

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
            { label: "Automatic (focus one, grid multiple)", value: "auto" },
            { label: "Side-by-side grid", value: "grid" },
            { label: "Fullscreen", value: "fullscreen" },
            { label: "Pop-out window", value: "popout" }
        ],
        onChange: () => applyCurrentDisplayMode()
    },
    autoMaximizeStream: {
        type: OptionType.BOOLEAN,
        description: "Automatically maximize a focused stream when not using grid or pop-out mode",
        default: false,
        onChange: () => applyCurrentDisplayMode()
    },
    autoHideMembers: {
        type: OptionType.BOOLEAN,
        description: "Automatically close the member panel while displaying a stream",
        default: false,
        onChange: () => applyMemberPanelSetting()
    },
    showOwnStreamInGrid: {
        type: OptionType.BOOLEAN,
        description: "Show your own screen share as a tile in side-by-side grid mode",
        default: false,
        onChange: () => applyCurrentDisplayMode()
    },
    autoMuteStreams: {
        type: OptionType.BOOLEAN,
        description: "Legacy automatic-mute setting",
        default: false,
        hidden: true
    },
    streamVolume: {
        type: OptionType.SELECT,
        description: "Audio volume to apply to streams watched by the plugin",
        options: [
            { label: "Leave unchanged", value: -1, default: true },
            { label: "Muted", value: 0 },
            { label: "25%", value: 25 },
            { label: "50%", value: 50 },
            { label: "75%", value: 75 },
            { label: "100%", value: 100 },
            { label: "150%", value: 150 },
            { label: "200%", value: 200 }
        ],
        onChange: () => applyStreamVolumeSetting()
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
    manualLockMinutes: {
        type: OptionType.SLIDER,
        description: "Minutes to lock after manual stream selection; 0 stays locked until manually unlocked",
        markers: [0, 5, 15, 30, 60],
        default: 0,
        stickToMarkers: true
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
const managedStreamVolumes = new Map<string, ManagedStreamVolume>();
const membersHiddenByPlugin = new Set<string>();
const managedLayouts = new Map<string, ManagedLayout>();

let scanTimer: ReturnType<typeof setTimeout> | undefined;
let lastChannelId: string | undefined;
let focusedStreamKey: string | undefined;
let sequence = 0;
let sessionLocked = false;
let internalSelection = false;
let internalStreamVolumeChange = false;
let internalMemberPanelChange = false;
let internalLayoutChange = false;
let lastAutoFocusAt = 0;
let lockTimer: ReturnType<typeof setTimeout> | undefined;
let lockedUntil: number | undefined;
let lastActiveStreamCount = 0;
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
    const watched = dispatch({ type: "STREAM_WATCH", streamKey: entry.key, allowMultiple });
    if (!watched) return false;

    if (!allowMultiple) {
        for (const userId of [...managedStreamVolumes.keys()]) {
            if (userId !== entry.stream.ownerId) restoreManagedStreamVolume(userId);
        }
    }
    applyConfiguredStreamVolume(entry);
    return true;
}

function setStreamVolume(userId: string, volume: number) {
    internalStreamVolumeChange = true;
    dispatch({ type: "AUDIO_SET_LOCAL_VOLUME", userId, volume, context: "stream" });
    internalStreamVolumeChange = false;
}

function applyConfiguredStreamVolume(entry: StreamEntry) {
    const configuredVolume = Number(settings.store.streamVolume);
    if (configuredVolume < 0 || managedStreamVolumes.has(entry.stream.ownerId)) return;

    const oldVolume = MediaEngineStore.getLocalVolume(entry.stream.ownerId, "stream");
    managedStreamVolumes.set(entry.stream.ownerId, {
        applied: configuredVolume,
        previous: oldVolume
    });
    setStreamVolume(entry.stream.ownerId, configuredVolume);
}

function restoreManagedStreamVolume(userId: string) {
    const managedVolume = managedStreamVolumes.get(userId);
    if (!managedVolume) return;

    managedStreamVolumes.delete(userId);
    if (MediaEngineStore.getLocalVolume(userId, "stream") === managedVolume.applied) {
        setStreamVolume(userId, managedVolume.previous);
    }
}

function restoreAllManagedStreamVolumes() {
    for (const userId of [...managedStreamVolumes.keys()]) restoreManagedStreamVolume(userId);
}

function applyStreamVolumeSetting() {
    restoreAllManagedStreamVolumes();
    if (Number(settings.store.streamVolume) < 0) return;

    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (!channelId) return;
    const entries = getEntries(channelId);
    const managedEntries = settings.store.streamMode === "replace"
        ? entries.filter(entry => entry.key === focusedStreamKey)
        : entries;
    for (const entry of managedEntries) applyConfiguredStreamVolume(entry);
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

function getDefaultLayout(channelId: string): "normal" | "no-chat" {
    return ChannelStore.getChannel(channelId)?.isGuildVocalOrThread() ? "no-chat" : "normal";
}

function setManagedLayout(channelId: string, layout: string) {
    const currentLayout = ChannelRTCStore.getLayout(channelId, "APP");
    const managedLayout = managedLayouts.get(channelId);
    if (!managedLayout && currentLayout === layout) return;

    const state = managedLayout ?? { applied: layout, previous: currentLayout };
    state.applied = layout;
    managedLayouts.set(channelId, state);

    internalLayoutChange = true;
    dispatch({ type: "CHANNEL_RTC_UPDATE_LAYOUT", channelId, layout, appContext: "APP" });
    internalLayoutChange = false;
}

function restoreManagedLayout(channelId: string) {
    const managedLayout = managedLayouts.get(channelId);
    if (!managedLayout) return;

    managedLayouts.delete(channelId);
    if (ChannelRTCStore.getLayout(channelId, "APP") !== managedLayout.applied) return;

    internalLayoutChange = true;
    dispatch({
        type: "CHANNEL_RTC_UPDATE_LAYOUT",
        channelId,
        layout: managedLayout.previous,
        appContext: "APP"
    });
    internalLayoutChange = false;
}

function setMemberPanelHidden(channelId: string, hidden: boolean) {
    if (hidden) {
        if (!ChannelRTCStore.getParticipantsOpen(channelId)) return;

        internalMemberPanelChange = true;
        const changed = dispatch({
            type: "CHANNEL_RTC_UPDATE_PARTICIPANTS_OPEN",
            channelId,
            participantsOpen: false
        });
        internalMemberPanelChange = false;
        if (changed) membersHiddenByPlugin.add(channelId);
    } else if (membersHiddenByPlugin.delete(channelId) && !ChannelRTCStore.getParticipantsOpen(channelId)) {
        internalMemberPanelChange = true;
        dispatch({
            type: "CHANNEL_RTC_UPDATE_PARTICIPANTS_OPEN",
            channelId,
            participantsOpen: true
        });
        internalMemberPanelChange = false;
    }
}

function applyMemberPanelSetting() {
    if (!settings.store.autoHideMembers) {
        for (const channelId of [...membersHiddenByPlugin]) setMemberPanelHidden(channelId, false);
        return;
    }

    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (channelId && focusedStreamKey) setMemberPanelHidden(channelId, true);
}

function resolveDisplayMode(channelId: string): ConcreteDisplayMode {
    const configuredMode = settings.store.displayMode as DisplayMode;
    let displayMode: ConcreteDisplayMode = configuredMode === "auto"
        ? getEntries(channelId).length > 1 ? "grid" : "normal"
        : configuredMode;

    if (displayMode === "normal" && settings.store.autoMaximizeStream) displayMode = "fullscreen";
    return displayMode;
}

function applyDisplayMode(channelId: string, streamKey: string) {
    const displayMode = resolveDisplayMode(channelId);
    const defaultLayout = getDefaultLayout(channelId);

    if (displayMode === "fullscreen") {
        setOwnStreamHidden(channelId, false);
        setManagedLayout(channelId, "full-screen");
    } else if (displayMode === "popout") {
        setOwnStreamHidden(channelId, false);
        restoreManagedLayout(channelId);
        dispatch({ type: "CALL_TILE_POPOUT_WINDOW_OPEN", channelId, participantId: streamKey });
    } else if (displayMode === "grid") {
        setOwnStreamHidden(channelId, !settings.store.showOwnStreamInGrid);
        setManagedLayout(channelId, defaultLayout);
        dispatch({ type: "CHANNEL_RTC_SELECT_PARTICIPANT", channelId, id: null });
    } else {
        setOwnStreamHidden(channelId, false);
        setManagedLayout(channelId, defaultLayout);
    }

    setMemberPanelHidden(channelId, settings.store.autoHideMembers);
}

function applyCurrentDisplayMode() {
    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (channelId && focusedStreamKey) applyDisplayMode(channelId, focusedStreamKey);
}

function restoreManagedUi(channelId: string) {
    setOwnStreamHidden(channelId, false);
    setMemberPanelHidden(channelId, false);
    restoreManagedLayout(channelId);
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
        if (lastChannelId) restoreManagedUi(lastChannelId);
        restoreAllManagedStreamVolumes();
        setLocked(false, false);
        clearRuntimeState();
        lastChannelId = currentChannelId;
    }
    if (!currentChannelId) return;

    const entries = getEntries(currentChannelId);
    const activeKeys = new Set(entries.map(entry => entry.key));
    const activeOwnerIds = new Set(entries.map(entry => entry.stream.ownerId));
    for (const userId of [...managedStreamVolumes.keys()]) {
        if (!activeOwnerIds.has(userId)) restoreManagedStreamVolume(userId);
    }

    const streamCountChanged = entries.length !== lastActiveStreamCount;
    lastActiveStreamCount = entries.length;

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
    if (entries.length === 0) {
        restoreManagedUi(currentChannelId);
        focusedStreamKey = undefined;
        return;
    }

    if (streamCountChanged && settings.store.displayMode === "auto" && focusedIsActive && focusedStreamKey) {
        applyDisplayMode(currentChannelId, focusedStreamKey);
    }

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
    lastActiveStreamCount = 0;
}

function setLocked(locked: boolean, announce = true, durationMinutes = 0) {
    const wasLocked = sessionLocked;
    if (lockTimer !== undefined) clearTimeout(lockTimer);
    lockTimer = undefined;
    lockedUntil = undefined;
    sessionLocked = locked;
    if (locked && durationMinutes > 0) {
        lockedUntil = Date.now() + durationMinutes * 60_000;
        lockTimer = setTimeout(() => setLocked(false), durationMinutes * 60_000);
    }

    if (announce) {
        const duration = locked && durationMinutes > 0 ? ` for ${durationMinutes} minutes` : "";
        notify(`AutoJoinStream focus ${locked ? `locked${duration}` : "unlocked"}`);
    }
    if (!locked && wasLocked) scheduleScan(0);
}

function cycleStream(direction: 1 | -1): boolean {
    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (!channelId) return false;

    const entries = getEntries(channelId).toSorted((a, b) =>
        (streamOrder.get(a.key) ?? 0) - (streamOrder.get(b.key) ?? 0)
    );
    if (entries.length === 0) return false;

    const currentIndex = entries.findIndex(entry => entry.key === focusedStreamKey);
    const targetIndex = currentIndex === -1
        ? direction === 1 ? 0 : entries.length - 1
        : (currentIndex + direction + entries.length) % entries.length;
    const target = entries[targetIndex];
    const allowMultiple = settings.store.streamMode !== "replace";
    if (!watch(target, allowMultiple) || !focus(target, "command")) return false;

    setLocked(true, false, settings.store.manualLockMinutes);
    return true;
}

function setFocusedStreamVolume(volume: number): boolean {
    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (!channelId || !focusedStreamKey) return false;

    const entry = getEntries(channelId).find(candidate => candidate.key === focusedStreamKey);
    if (!entry) return false;

    managedStreamVolumes.delete(entry.stream.ownerId);
    setStreamVolume(entry.stream.ownerId, volume);
    return true;
}

function getStatus(): string {
    const channelId = SelectedChannelStore.getVoiceChannelId();
    return [
        `**AutoJoinStream:** ${compatible ? "compatible" : "compatibility error"}`,
        `**Mode:** ${settings.store.streamMode}`,
        `**Display:** ${settings.store.displayMode}`,
        `**Stream volume:** ${Number(settings.store.streamVolume) < 0 ? "unchanged" : `${settings.store.streamVolume}%`}`,
        `**Focus lock:** ${sessionLocked
            ? lockedUntil ? `locked until ${new Date(lockedUntil).toLocaleTimeString()}` : "locked"
            : "unlocked"}`,
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
            {
                name: "lock",
                description: "Temporarily stop automatic focus changes",
                type: ApplicationCommandOptionType.SUB_COMMAND,
                options: [{
                    name: "minutes",
                    description: "Automatically unlock after this many minutes; omit to stay locked",
                    type: ApplicationCommandOptionType.INTEGER
                }]
            },
            { name: "unlock", description: "Resume automatic focus changes", type: ApplicationCommandOptionType.SUB_COMMAND },
            { name: "next", description: "Focus the next active stream", type: ApplicationCommandOptionType.SUB_COMMAND },
            { name: "previous", description: "Focus the previous active stream", type: ApplicationCommandOptionType.SUB_COMMAND },
            {
                name: "volume",
                description: "Set the focused stream's volume",
                type: ApplicationCommandOptionType.SUB_COMMAND,
                options: [{
                    name: "percent",
                    description: "Volume from 0 to 200 percent",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: true
                }]
            },
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
            if (subcommand.name === "lock") {
                const minutes = Math.min(1440, Math.max(0, Number(findOption(subcommand.options, "minutes", 0))));
                setLocked(true, true, minutes);
            }
            else if (subcommand.name === "unlock") setLocked(false);
            else if (subcommand.name === "next") cycleStream(1);
            else if (subcommand.name === "previous") cycleStream(-1);
            else if (subcommand.name === "volume") {
                const volume = Math.min(200, Math.max(0, Number(findOption(subcommand.options, "percent", 100))));
                setFocusedStreamVolume(volume);
            }
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
                if (settings.store.pauseOnManualFocus && knownStreamKeys.size > 0) {
                    setLocked(true, true, settings.store.manualLockMinutes);
                }
            }
        },
        AUDIO_SET_LOCAL_VOLUME({ userId, context }: { userId: string; context?: string; }) {
            if (!internalStreamVolumeChange && context === "stream") managedStreamVolumes.delete(userId);
        },
        CHANNEL_RTC_UPDATE_LAYOUT({ channelId, appContext }: { channelId: string; appContext?: string; }) {
            if (!internalLayoutChange && (!appContext || appContext === "APP")) managedLayouts.delete(channelId);
        },
        CHANNEL_RTC_UPDATE_PARTICIPANTS_OPEN({ channelId }: { channelId: string; }) {
            if (!internalMemberPanelChange) membersHiddenByPlugin.delete(channelId);
        },
        STREAM_TIMED_OUT({ streamKey }: { streamKey: string; }) {
            if (knownStreamKeys.has(streamKey)) notify("A watched stream timed out", Toasts.Type.FAILURE);
        }
    },

    start() {
        if (settings.store.autoMuteStreams && Number(settings.store.streamVolume) < 0) {
            settings.store.streamVolume = 0;
            settings.store.autoMuteStreams = false;
        }
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
        if (lockTimer !== undefined) clearTimeout(lockTimer);
        lockTimer = undefined;
        for (const channelId of selfStreamsHiddenByPlugin) {
            dispatch({ type: "STREAM_UPDATE_SELF_HIDDEN", channelId, selfStreamHidden: false });
        }
        selfStreamsHiddenByPlugin.clear();
        for (const channelId of new Set([
            ...membersHiddenByPlugin,
            ...managedLayouts.keys()
        ])) restoreManagedUi(channelId);
        restoreAllManagedStreamVolumes();
        clearRuntimeState();
        lastChannelId = undefined;
        sessionLocked = false;
        lockedUntil = undefined;
    }
});
