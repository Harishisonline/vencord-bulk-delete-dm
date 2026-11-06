/*
 * Vencord, a modification for Discord's desktop app
 *
 * BulkDeleteDm - bulk delete your own messages inside DMs.
 *
 * Discord's REST API only exposes bulk deletion on guild channels via
 * POST /channels/{id}/messages/bulk-delete (which requires MANAGE_MESSAGES).
 * There is no equivalent for DMs, so this plugin walks the DM history and
 * deletes each of your own messages individually via
 * DELETE /channels/{id}/messages/{message_id}, which does work in DMs.
 */

import { definePluginSettings } from "@api/Settings";
import { confirmAction } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelType } from "@vencord/discord-types/enums";
import { AuthenticationStore, ChannelStore, Constants, FluxDispatcher, Menu, RestAPI, showToast } from "@webpack/common";

const logger = new Logger("BulkDeleteDm");

const PAGE_SIZE = 100;

/** Discord rate limits message deletion. Stay well under it. */
const DEFAULT_DELAY_MS = 1200;

/**
 * Message types Discord refuses to delete even from their own author.
 * Calling DELETE on these returns 403 / 50021 "Cannot execute action on a
 * system message", so we skip them instead of reporting a failure.
 */
const UNDELETABLE_MESSAGE_TYPES = new Set([
    1, // RECIPIENT_ADD
    2, // RECIPIENT_REMOVE
    3, // CALL
    4, // CHANNEL_NAME_CHANGE
    5, // CHANNEL_ICON_CHANGE
    21 // THREAD_STARTER_MESSAGE
]);

interface DmMessage {
    id: string;
    channel_id: string;
    author: { id: string };
    type?: number;
}

interface RestError {
    status?: number;
    body?: { message?: string; retry_after?: number; code?: number };
    retryAfter?: number;
    headers?: Record<string, string>;
}

/**
 * Discord's request layer rejects on non-2xx. The rejection value carries
 * `status`, `body` and `retryAfter` (in SECONDS, taken from the retry-after
 * header or body.retry_after).
 */
function getRetryAfterSeconds(err: unknown): number {
    const e = err as RestError | undefined;
    if (!e) return 1;

    if (typeof e.retryAfter === "number" && e.retryAfter > 0) return e.retryAfter;

    const bodyRetry = e.body?.retry_after;
    if (typeof bodyRetry === "number" && bodyRetry > 0) return bodyRetry;

    const header = e.headers?.["retry-after"] ?? e.headers?.["Retry-After"];
    if (typeof header === "string") {
        const parsed = parseInt(header, 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }

    return 1;
}

function getStatus(err: unknown): number | undefined {
    const e = err as RestError | undefined;
    return typeof e?.status === "number" ? e.status : undefined;
}

function getErrorCode(err: unknown): number | undefined {
    const e = err as RestError | undefined;
    return typeof e?.body?.code === "number" ? e.body.code : undefined;
}

function sleep(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
}

const settings = definePluginSettings({
    delayMs: {
        type: OptionType.SLIDER,
        description: "Delay between each delete request. Raise this if you hit rate limits.",
        markers: [400, 800, 1200, 1600, 2000, 2500, 3000],
        default: DEFAULT_DELAY_MS,
        stickToMarkers: false
    },
    maxMessages: {
        type: OptionType.NUMBER,
        description: "Maximum number of your messages to delete in one run. Raise it if a DM has more than this.",
        default: 200
    },
    confirmBeforeDelete: {
        type: OptionType.BOOLEAN,
        description: "Ask for confirmation before deleting",
        default: true
    },
    removeFromView: {
        type: OptionType.BOOLEAN,
        description: "Make the chat view match the server afterwards. Turn this off to keep MessageLogger's red 'deleted' markers instead.",
        default: true
    }
});

function isDmChannel(channelId: string): boolean {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return false;
    return channel.type === ChannelType.DM || channel.type === ChannelType.GROUP_DM;
}

interface FetchResult {
    messages: DmMessage[];
    skipped: number;
    hitLimit: boolean;
}

/**
 * Collect every message in the channel that was authored by the current user.
 * Discord returns messages newest-first, so we page backwards with `before`.
 */
async function fetchOwnMessages(channelId: string, maxMessages: number): Promise<FetchResult> {
    const me = AuthenticationStore.getId();
    const collected: DmMessage[] = [];
    let skipped = 0;
    let before: string | undefined;
    let hitLimit = false;

    // Hard stop on page count so a huge channel cannot spin forever.
    for (let page = 0; page < 200; page++) {
        const query: Record<string, any> = { limit: PAGE_SIZE };
        if (before) query.before = before;

        const res = await RestAPI.get({
            url: Constants.Endpoints.MESSAGES(channelId),
            query,
            retries: 2
        });

        const messages: DmMessage[] = res?.body ?? [];
        if (!Array.isArray(messages) || messages.length === 0) break;

        for (const message of messages) {
            if (message?.author?.id !== me) continue;

            if (typeof message.type === "number" && UNDELETABLE_MESSAGE_TYPES.has(message.type)) {
                skipped++;
                continue;
            }

            collected.push(message);

            // Collect one extra so we can tell the user the limit was hit
            // instead of silently stopping.
            if (collected.length > maxMessages) {
                hitLimit = true;
                collected.pop();
                return { messages: collected, skipped, hitLimit };
            }
        }

        const oldest = messages[messages.length - 1];
        if (!oldest?.id) break;
        before = oldest.id;
    }

    return { messages: collected, skipped, hitLimit };
}

type DeleteOutcome = "deleted" | "already-gone" | "skipped" | "failed";

/**
 * Delete a single message. On 429 we wait out the rate limit and retry.
 */
async function deleteMessage(channelId: string, messageId: string): Promise<DeleteOutcome> {
    const url = Constants.Endpoints.MESSAGE(channelId, messageId);

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            await RestAPI.del({ url, oldFormErrors: true });
            return "deleted";
        } catch (err) {
            const status = getStatus(err);

            if (status === 429) {
                const waitSeconds = getRetryAfterSeconds(err);
                logger.warn(`Rate limited, waiting ${waitSeconds}s before retrying`);
                await sleep(waitSeconds * 1000 + 250);
                continue;
            }

            // 404 means the message is already gone. Nothing left to do.
            if (status === 404) return "already-gone";

            // Discord refuses to delete some of its own system messages.
            if (status === 403 && getErrorCode(err) === 50021) return "skipped";

            logger.error(`Failed to delete message ${messageId}`, err);
            return "failed";
        }
    }

    return "failed";
}

/**
 * Update the chat view so it reflects what is actually on the server.
 *
 * Discord's own delete path dispatches MESSAGE_DELETE and lets MessageStore
 * drop the message. With MessageLogger enabled that event is intercepted and
 * the message is kept around as a red "deleted" marker instead, which is what
 * makes a deleted message still look present.
 *
 * `mlDeleted` makes MessageLogger remove the message outright instead, and
 * vanilla Discord ignores the extra field, so this works either way.
 */
function removeMessageLocally(channelId: string, messageId: string, removeFromView: boolean) {
    FluxDispatcher.dispatch({
        type: "MESSAGE_DELETE",
        channelId,
        id: messageId,
        ...(removeFromView ? { mlDeleted: true } : {})
    });
}

/**
 * Drop the channel's cached message list so Discord refetches it from the
 * server.
 *
 * Deleting through the REST API only updates the local cache for the messages
 * it knows about. Anything Discord still had cached but the server no longer
 * has stays on screen, which makes a finished cleanup look unfinished.
 * CLEAR_MESSAGES is Discord's own action for this and it refetches the
 * channel afterwards, so the view ends up matching the server exactly.
 */
function resyncChannel(channelId: string) {
    FluxDispatcher.dispatch({ type: "CLEAR_MESSAGES", channelId });
}

interface RunResult {
    deleted: number;
    gone: number;
    skipped: number;
    failed: number;
}

async function runBulkDelete(channelId: string, messages: DmMessage[], removeFromView: boolean): Promise<RunResult> {
    const delay = settings.store.delayMs;

    let deleted = 0;
    let gone = 0;
    let skipped = 0;
    let failed = 0;

    // Discord hands us newest-first. Delete oldest-first so the remaining
    // history stays coherent while the run is in progress.
    const ordered = [...messages].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

    for (const message of ordered) {
        const outcome = await deleteMessage(channelId, message.id);

        if (outcome === "deleted") {
            deleted++;
            removeMessageLocally(channelId, message.id, removeFromView);
        } else if (outcome === "already-gone") {
            gone++;
        } else if (outcome === "skipped") {
            skipped++;
        } else {
            failed++;
        }

        if (delay > 0) await sleep(delay);
    }

    // Reconcile the view with the server once the run is done.
    if (removeFromView) resyncChannel(channelId);

    return { deleted, gone, skipped, failed };
}

function reportRun(result: RunResult, hitLimit: boolean, maxMessages: number) {
    const parts = [`${result.deleted} message${result.deleted === 1 ? "" : "s"} deleted`];

    if (result.gone > 0) parts.push(`${result.gone} already gone`);
    if (result.skipped > 0) parts.push(`${result.skipped} skipped (Discord refuses to delete some system messages)`);
    if (result.failed > 0) parts.push(`${result.failed} failed`);
    if (hitLimit) parts.push(`stopped at the ${maxMessages} message limit, older messages were left`);

    showToast({
        text: parts.join(", "),
        variant: result.failed > 0 ? "critical" : "success"
    });
}

async function deleteAllInChannel(channelId: string, anchorId?: string) {
    const max = settings.store.maxMessages;

    let fetched: FetchResult;
    try {
        fetched = await fetchOwnMessages(channelId, max);
    } catch (err) {
        logger.error("Failed to fetch messages", err);
        showToast({ text: "Could not load message history", variant: "critical" });
        return;
    }

    let messages = fetched.messages;

    if (anchorId) {
        // Snowflakes increase with time, so a larger id is a newer message.
        const anchor = BigInt(anchorId);
        messages = messages.filter(m => BigInt(m.id) >= anchor);
    }

    if (messages.length === 0) {
        showToast({
            text: fetched.skipped > 0
                ? `No deletable messages of yours found (${fetched.skipped} system message skipped)`
                : "No messages of yours found in this DM",
            variant: "default"
        });
        return;
    }

    const subtitleParts = [`This will permanently delete ${messages.length} of your messages.`];
    if (fetched.skipped > 0) subtitleParts.push(`${fetched.skipped} system message(s) cannot be deleted and will be skipped.`);
    if (fetched.hitLimit) subtitleParts.push(`Only the newest ${max} of your messages are included. Raise "maxMessages" in the plugin settings to include more.`);

    const doDelete = async () => {
        const result = await runBulkDelete(channelId, messages, settings.store.removeFromView);
        reportRun(result, fetched.hitLimit, max);
    };

    if (!settings.store.confirmBeforeDelete) {
        void doDelete();
        return;
    }

    void confirmAction({
        title: anchorId ? "Delete this message and your newer ones?" : "Delete all your messages in this DM?",
        subtitle: subtitleParts.join(" "),
        confirmText: "Delete",
        variant: "critical-primary",
        onConfirm: doDelete
    });
}

export default definePlugin({
    name: "BulkDeleteDm",
    description: "Bulk delete your own messages inside DMs, where Discord's bulk delete API does not work.",
    authors: [{ name: "Harish", id: 0n }],
    tags: ["Chat", "Utility"],

    settings,
    enabledByDefault: true,

    contextMenus: {
        // Right click one of your own messages inside a DM.
        "message": (children, props: { message?: DmMessage }) => {
            const message = props?.message;
            if (!message?.channel_id) return;

            const me = AuthenticationStore.getId();
            if (message.author?.id !== me) return;
            if (!isDmChannel(message.channel_id)) return;

            children.push(
                <Menu.MenuItem
                    id="bulk-delete-dm-all"
                    label="Delete All My Messages In This DM"
                    color="danger"
                    action={() => void deleteAllInChannel(message.channel_id)}
                />
            );

            children.push(
                <Menu.MenuItem
                    id="bulk-delete-dm-newer"
                    label="Delete This Message And My Newer Ones"
                    color="danger"
                    action={() => void deleteAllInChannel(message.channel_id, message.id)}
                />
            );
        },

        // Right click a DM in the sidebar. Discord reuses "user-context" for
        // both the member list and DM rows, so only act when a channel is present.
        "user-context": (children, props: { channel?: { id: string; type: number } }) => {
            const channel = props?.channel;
            if (!channel?.id) return;
            if (!isDmChannel(channel.id)) return;

            children.push(
                <Menu.MenuItem
                    id="bulk-delete-dm-channel"
                    label="Delete All My Messages In This DM"
                    color="danger"
                    action={() => void deleteAllInChannel(channel.id)}
                />
            );
        },

        // Right click a group DM in the sidebar.
        "gdm-context": (children, props: { channel?: { id: string; type: number } }) => {
            const channel = props?.channel;
            if (!channel?.id) return;
            if (!isDmChannel(channel.id)) return;

            children.push(
                <Menu.MenuItem
                    id="bulk-delete-dm-gdm"
                    label="Delete All My Messages In This DM"
                    color="danger"
                    action={() => void deleteAllInChannel(channel.id)}
                />
            );
        }
    }
});
