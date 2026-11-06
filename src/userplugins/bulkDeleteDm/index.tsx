/*
 * Vencord, a modification for Discord's desktop app
 *
 * BulkDeleteDm - bulk delete your own messages inside DMs.
 *
 * Discord's REST API only exposes bulk deletion on guild channels via
 * POST /channels/{id}/messages/bulk-delete, and that endpoint is bot-only
 * (HTTP 403, code 20002 "Only bots can use this endpoint"). There is no
 * equivalent for DMs, so this plugin walks the DM history and deletes each
 * of your own messages individually via
 * DELETE /channels/{id}/messages/{message_id}, which does work in DMs.
 *
 * Deleting thousands of messages one at a time is slow and makes the client
 * crawl, so this version:
 *   - pages backwards and deletes as it goes, instead of collecting the whole
 *     history into memory first
 *   - runs several delete requests in parallel, behind a shared rate-limit
 *     gate that honours Discord's retry_after
 *   - removes messages from the local store in batches via MESSAGE_DELETE_BULK
 *     instead of dispatching one event per message
 *   - shows a live progress modal that can be cancelled
 */

import { definePluginSettings } from "@api/Settings";
import { findByProps } from "@webpack";
import { confirmAction } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelType } from "@vencord/discord-types/enums";
import {
    AuthenticationStore,
    ChannelStore,
    Constants,
    FluxDispatcher,
    Menu,
    Modal,
    openModal,
    RestAPI,
    showToast
} from "@webpack/common";
import { React, useEffect, useState } from "@webpack/common";

const logger = new Logger("BulkDeleteDm");

const PAGE_SIZE = 100;

/** Discord caps a page at 100 messages. */
const MAX_PAGES = 1000;

/**
 * How many queued messages are deleted between two progress updates.
 *
 * Small enough that the progress display keeps moving and Cancel stays
 * responsive, large enough that the per-chunk overhead is negligible.
 */
const FLUSH_CHUNK = 10;

/**
 * How many delete requests may be in flight at once.
 *
 * Discord's delete bucket punishes bursts far more than it rewards
 * parallelism. Measured against the live API, a single sequential request
 * already runs at about 2.3 deletions per second with no throttling at all,
 * while eight simultaneous requests produced a 429 for nearly every one of
 * them and finished slower. Two workers is enough to keep the network busy
 * without setting off the bucket.
 */
const DEFAULT_CONCURRENCY = 2;

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
    body?: { message?: string; retry_after?: number; code?: number; global?: boolean };
    retryAfter?: number;
    headers?: Record<string, string>;
}

/**
 * Discord's request layer rejects on non-2xx. The rejection value carries
 * `status`, `body` and `retryAfter`.
 *
 * `body.retry_after` is the precise value Discord wants us to wait for and can
 * be fractional (0.3s). `retryAfter` is derived from the `retry-after`
 * header, which is rounded up to whole seconds. Prefer the precise one and
 * only fall back to the header.
 */
function getRetryAfterSeconds(err: unknown): number {
    const e = err as RestError | undefined;
    if (!e) return 1;

    const bodyRetry = e.body?.retry_after;
    if (typeof bodyRetry === "number" && bodyRetry > 0) return bodyRetry;

    if (typeof e.retryAfter === "number" && e.retryAfter > 0) return e.retryAfter;

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

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/**
 * Vencord's built-in number input has a trap: it writes whatever you type
 * into the settings store, but then calls `BigInt(newValue)` to clamp it.
 * `BigInt("1.5")` throws a SyntaxError, which aborts the handler before the
 * input's own state is updated. The result is a value that is saved but never
 * shown, so the field keeps displaying the old number and it looks like the
 * edit was rejected.
 *
 * This component replaces the number inputs with one that keeps its own
 * draft state, only commits valid integers, and shows what was actually
 * saved. It also gives the user a live read-out of the current settings so
 * there is never any doubt about whether a change took effect.
 */
function IntegerSetting(props: {
    label: string;
    description: string;
    value: number;
    min: number;
    max: number;
    allowUnlimited?: boolean;
    onCommit: (value: number) => void;
}) {
    const { label, description, value, min, max, allowUnlimited, onCommit } = props;

    const [draft, setDraft] = useState<string>(String(value));
    const [saved, setSaved] = useState(false);

    // Re-sync the draft when the stored value changes from somewhere else.
    useEffect(() => {
        setDraft(String(value));
    }, [value]);

    const parsed = draft.trim() === "" ? NaN : Number(draft.trim());
    const valid =
        Number.isInteger(parsed) &&
        parsed >= min &&
        parsed <= max &&
        (allowUnlimited || parsed > 0 || parsed === 0);

    const commit = () => {
        if (!valid) {
            // Snap the field back to what is actually stored.
            setDraft(String(value));
            return;
        }
        onCommit(parsed);
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
    };

    return (
        <div style={{ marginBottom: "1rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
                <span style={{ fontWeight: 600 }}>{label}</span>
                {saved && <span style={{ color: "var(--text-positive, #23a55a)", fontSize: "0.85rem" }}>Saved</span>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <input
                    type="number"
                    className="vc-input"
                    value={draft}
                    min={min}
                    max={max}
                    step={1}
                    onChange={(e: any) => setDraft(e.target.value)}
                    onKeyDown={(e: any) => {
                        if (e.key === "Enter") commit();
                    }}
                    onBlur={commit}
                    style={{
                        width: "7rem",
                        padding: "0.35rem 0.5rem",
                        borderRadius: "4px",
                        border: "1px solid var(--background-modifier-accent, #4f5664)",
                        background: "var(--input-background, #1e1f22)",
                        color: "var(--text-normal, #dbdee1)"
                    }}
                />
                <button className="button-primary" onClick={commit} disabled={!valid}>
                    Apply
                </button>
            </div>
            <div style={{ fontSize: "0.8rem", opacity: 0.7, marginTop: "0.25rem" }}>
                {description}
                {!valid && (
                    <span style={{ color: "var(--text-danger, #f23f43)" }}>
                        {" "}
                        Enter a whole number between {min} and {max}.
                    </span>
                )}
            </div>
            <div style={{ fontSize: "0.8rem", opacity: 0.55, marginTop: "0.15rem" }}>Currently saved: {value}</div>
        </div>
    );
}

/**
 * Read the two numeric settings.
 *
 * Vencord's settings proxy returns a fresh wrapper object on every access,
 * so the stored object cannot be spread or compared by identity. Reading the
 * individual fields is the only reliable way to get the real values.
 */
function readLimits(): { maxMessages: number; concurrency: number } {
    const stored = settings.store.limits as any;
    return {
        maxMessages: typeof stored?.maxMessages === "number" ? stored.maxMessages : 200,
        concurrency: typeof stored?.concurrency === "number" ? stored.concurrency : DEFAULT_CONCURRENCY
    };
}

const settings = definePluginSettings({
    limits: {
        type: OptionType.COMPONENT,
        description: "How many messages to delete and how fast to go.",
        component: (props: any) => {
            const { setValue } = props;
            // Vencord's settings proxy hands back a new wrapper on every
            // access, so the object identity is not stable. Read the fields
            // rather than spreading the object.
            const current = readLimits();

            return (
                <div>
                    <IntegerSetting
                        label="Maximum messages per run"
                        description="How many of your messages to delete in one go. Use 0 for no limit, which walks the whole DM."
                        value={current.maxMessages}
                        min={0}
                        max={1_000_000}
                        allowUnlimited
                        onCommit={maxMessages => setValue({ ...current, maxMessages })}
                    />
                    <IntegerSetting
                        label="Delete requests running at once"
                        description="Two is the sweet spot. Higher values make Discord throttle the account and the run ends up slower, not faster."
                        value={current.concurrency}
                        min={1}
                        max={4}
                        onCommit={concurrency => setValue({ ...current, concurrency })}
                    />
                </div>
            );
        },
        default: {
            maxMessages: 200,
            concurrency: DEFAULT_CONCURRENCY
        }
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

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

/**
 * A paced request scheduler for message deletion.
 *
 * Measurements against Discord's delete endpoint (see betterment.md) showed
 * two things that drove this design:
 *
 *   1. A single request takes roughly 400ms end to end, so a sequential loop
 *      with no artificial delay already runs at about 2.3 deletions per
 *      second and never trips the rate limiter.
 *   2. Bursting requests is what triggers throttling. Firing eight deletes
 *      at once produced a 429 for almost every one of them, and the retry
 *      storm that followed made the run slower than doing nothing at all.
 *
 * So the scheduler spreads requests evenly over time instead of bursting
 * them. Every worker claims its slot before waiting, so several workers can
 * overlap the network round trip without ever colliding on the bucket.
 *
 * On a 429 the whole bucket is throttled, so every worker pauses for
 * Discord's retry_after and the spacing is widened. After a run of clean
 * requests the spacing is tightened again, so the controller settles on the
 * fastest rate the bucket actually allows.
 */
class DeleteScheduler {
    /** Earliest time the next request may be sent. */
    private nextAllowedAt = 0;
    /** Set while the whole bucket is throttled. */
    private pausedUntil = 0;
    /** Consecutive clean requests since the last 429. */
    private cleanStreak = 0;
    /** Current spacing between requests. */
    private spacing: number;

    private static readonly MIN_SPACING = 300;
    private static readonly MAX_SPACING = 2500;

    /**
     * The steady state refill rate of Discord's delete bucket.
     *
     * Measured against the live API: once the burst allowance is spent, the
     * bucket refills at roughly one request every two seconds. The 429
     * responses alternate perfectly with the successes, and the gap between
     * consecutive successful deletes settles at a median of about 2020ms.
     */
    private static readonly REFILL_SPACING = 2000;

    constructor(spacing = 400) {
        this.spacing = spacing;
    }

    /**
     * Claim a slot and wait for it.
     *
     * The slot is claimed synchronously before the wait, so several workers
     * calling this at the same time each get a different slot instead of all
     * waking up together and colliding on the bucket.
     *
     * The pause is re-checked after waiting. A worker that reserved a slot
     * before a 429 arrived still has to wait out the throttle, otherwise the
     * pause only affects workers that happen to reserve after it.
     */
    async reserve(): Promise<void> {
        for (;;) {
            const now = Date.now();
            const slot = Math.max(this.nextAllowedAt, this.pausedUntil);

            this.nextAllowedAt = slot + this.spacing;

            const wait = slot - now;
            if (wait > 0) await sleep(wait);

            // A throttle may have arrived while we were waiting.
            if (this.pausedUntil > Date.now()) continue;

            return;
        }
    }

    /**
     * The bucket throttled us. Pause everyone and settle at the refill rate.
     *
     * Discord's delete bucket allows a short burst and then refills slowly.
     * Measured against the live API, the steady state is one delete roughly
     * every two seconds, and the response pattern alternates perfectly
     * between a success and a 429. The `retry_after` on the 429 says how
     * long that one request has to wait, which is close to the refill
     * interval.
     *
     * So the spacing jumps straight to the refill interval instead of
     * creeping towards it. Creeping is what made the earlier version slow:
     * every throttle only added a little, so the run kept firing into a
     * closed bucket and threw away roughly half its requests on 429s.
     */
    onThrottled(retryAfterSeconds: number): void {
        this.cleanStreak = 0;

        // Wait exactly as long as Discord asked, plus a small margin so the
        // next request lands after the bucket has actually refilled.
        const pauseMs = Math.ceil(retryAfterSeconds * 1000) + 50;
        this.pausedUntil = Date.now() + pauseMs;

        this.spacing = Math.min(
            DeleteScheduler.MAX_SPACING,
            Math.max(this.spacing, DeleteScheduler.REFILL_SPACING)
        );
    }

    /**
     * A request went through cleanly.
     *
     * After a long clean stretch the bucket has probably refilled, so the
     * spacing is allowed to shrink again and pick up the burst allowance.
     * This is deliberately slow, so a run does not oscillate between fast
     * and slow.
     */
    onSuccess(): void {
        this.cleanStreak++;
        if (this.cleanStreak >= 40 && this.spacing > DeleteScheduler.MIN_SPACING) {
            this.cleanStreak = 0;
            this.spacing = Math.max(DeleteScheduler.MIN_SPACING, this.spacing - 100);
        }
    }

    /** Current spacing, for diagnostics. */
    get currentSpacing(): number {
        return this.spacing;
    }
}

type DeleteOutcome = "deleted" | "already-gone" | "skipped" | "failed";

interface DeleteCounters {
    deleted: number;
    gone: number;
    skipped: number;
    failed: number;
    rateLimited: number;
}

/**
 * Delete a single message, retrying through the shared limiter on 429.
 */
async function deleteMessage(
    channelId: string,
    messageId: string,
    scheduler: DeleteScheduler,
    counters: DeleteCounters
): Promise<DeleteOutcome> {
    const url = Constants.Endpoints.MESSAGE(channelId, messageId);

    for (let attempt = 0; attempt < 8; attempt++) {
        await scheduler.reserve();
        try {
            await RestAPI.del({ url, oldFormErrors: true });
            scheduler.onSuccess();
            return "deleted";
        } catch (err) {
            const status = getStatus(err);

            if (status === 429) {
                counters.rateLimited++;
                const waitSeconds = getRetryAfterSeconds(err);
                scheduler.onThrottled(waitSeconds);
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

/* ------------------------------------------------------------------ */
/* Local store updates                                                 */
/* ------------------------------------------------------------------ */

/**
 * Remove messages from the local view.
 *
 * Dispatching one MESSAGE_DELETE per message makes React re-render the
 * message list once per message, which is what makes the client crawl during
 * a large run. MESSAGE_DELETE_BULK removes the whole set in one go, and
 * Discord's own MessageStore handles it by removing each id.
 *
 * `mlDeleted` makes MessageLogger remove the messages outright instead of
 * keeping them as red "deleted" markers, and vanilla Discord ignores the
 * extra field, so this works either way.
 */
function removeMessagesLocally(channelId: string, messageIds: string[], removeFromView: boolean) {
    if (messageIds.length === 0) return;

    FluxDispatcher.dispatch({
        type: "MESSAGE_DELETE_BULK",
        channelId,
        ids: messageIds,
        ...(removeFromView ? { mlDeleted: true } : {})
    });
}

/* ------------------------------------------------------------------ */
/* Progress UI                                                         */
/* ------------------------------------------------------------------ */

interface ProgressState {
    phase: "scanning" | "deleting";
    scanned: number;
    total: number;
    deleted: number;
    gone: number;
    skipped: number;
    failed: number;
    rateLimited: number;
    /** Messages per second, measured over the run so far. */
    perSecond: number;
    /** Estimated seconds remaining, or null if it cannot be estimated yet. */
    etaSeconds: number | null;
    done: boolean;
    cancelled: boolean;
}

function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return "0s";
    const total = Math.round(ms / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Keeps the progress state and notifies the modal when it changes.
 *
 * The modal is rendered by Discord's own modal stack, so it cannot be given
 * React state from the outside. A tiny subscription keeps it in sync.
 */
class ProgressTracker {
    private state: ProgressState;
    private listeners = new Set<(state: ProgressState) => void>();

    constructor(initial: ProgressState) {
        this.state = initial;
    }

    get current(): ProgressState {
        return this.state;
    }

    update(next: ProgressState) {
        this.state = next;
        for (const listener of this.listeners) listener(next);
    }

    subscribe(listener: (state: ProgressState) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}

/**
 * A live progress modal. A run over a few thousand messages takes minutes,
 * so the user needs to see that something is happening and be able to stop it.
 */
function ProgressModal({
    modalProps,
    tracker,
    onCancel
}: {
    modalProps: any;
    tracker: ProgressTracker;
    onCancel: () => void;
}) {
    const [state, setState] = useState<ProgressState>(tracker.current);

    useEffect(() => tracker.subscribe(setState), [tracker]);

    const processed = state.deleted + state.gone + state.skipped + state.failed;
    const percent = state.total > 0 ? Math.min(100, (processed / state.total) * 100) : 0;

    return (
        <Modal {...modalProps} title="Bulk deleting your messages">
            <div style={{ padding: "1rem 1.25rem", minWidth: "22rem" }}>
                <div style={{ marginBottom: "0.75rem", fontSize: "0.95rem" }}>
                    {state.phase === "scanning" && <>Scanning the DM for your messages, found {state.scanned} so far...</>}
                    {state.phase === "deleting" && !state.done && (
                        <>
                            Deleted {processed} of {state.total}
                            {state.perSecond > 0 && <> at {state.perSecond.toFixed(1)}/s</>}
                            {state.etaSeconds !== null && <> (about {formatDuration(state.etaSeconds * 1000)} left)</>}
                            {state.rateLimited > 0 && <> (throttled {state.rateLimited} times)</>}
                        </>
                    )}
                    {state.done && (
                        <>
                            Done. Deleted {state.deleted}
                            {state.gone > 0 && <>, {state.gone} were already gone</>}
                            {state.skipped > 0 && <>, {state.skipped} skipped</>}
                            {state.failed > 0 && <>, {state.failed} failed</>}
                            {state.rateLimited > 0 && <>, throttled {state.rateLimited} times</>}
                        </>
                    )}
                    {state.cancelled && !state.done && <>Cancelled.</>}
                </div>

                <div
                    style={{
                        height: "8px",
                        borderRadius: "4px",
                        background: "var(--background-secondary, #4f5664)",
                        overflow: "hidden"
                    }}
                >
                    <div
                        style={{
                            height: "100%",
                            width: `${percent}%`,
                            background: "var(--brand-experiment, #5865f2)",
                            transition: "width 120ms linear"
                        }}
                    />
                </div>

                {!state.done && (
                    <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
                        <button
                            className="button-primary"
                            style={{ background: "var(--danger, #da373c)", color: "#fff" }}
                            onClick={onCancel}
                        >
                            Cancel
                        </button>
                    </div>
                )}
            </div>
        </Modal>
    );
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

interface RunResult extends DeleteCounters {
    truncated: boolean;
    hitLimit: boolean;
    elapsedMs: number;
    scanned: number;
}

interface RunOptions {
    channelId: string;
    maxMessages: number;
    concurrency: number;
    removeFromView: boolean;
    anchorId?: string;
    onProgress: (state: ProgressState) => void;
    shouldCancel: () => boolean;
}

/**
 * Walk the DM backwards, deleting your own messages as they are found.
 *
 * Scanning and deleting are interleaved on purpose. Collecting the whole
 * history first means the client sits idle for a minute on a long DM, and
 * the confirmation dialog cannot say how many messages there are until the
 * very end.
 */
async function runBulkDelete(options: RunOptions): Promise<RunResult> {
    const { channelId, concurrency, removeFromView, anchorId, onProgress, shouldCancel } = options;

    const me = AuthenticationStore.getId();
    const scheduler = new DeleteScheduler();
    const counters: DeleteCounters = { deleted: 0, gone: 0, skipped: 0, failed: 0, rateLimited: 0 };

    const startTime = Date.now();
    let before: string | undefined;
    let scanned = 0;
    let collected = 0;
    let hitLimit = false;
    let truncated = false;
    let cancelled = false;

    const pending: DmMessage[] = [];

    /**
     * Build a progress snapshot with the current speed and an estimate of
     * how much longer the run will take.
     */
    const progressSnapshot = (phase: "scanning" | "deleting", done: boolean): ProgressState => {
        const processed = counters.deleted + counters.gone + counters.skipped + counters.failed;
        const elapsedSeconds = Math.max(0.001, (Date.now() - startTime) / 1000);
        const perSecond = processed / elapsedSeconds;
        const remaining = Math.max(0, collected - processed);

        return {
            phase,
            scanned,
            total: collected,
            ...counters,
            perSecond: done ? 0 : perSecond,
            etaSeconds: !done && perSecond > 0 ? remaining / perSecond : null,
            done,
            cancelled
        };
    };

    /**
     * Delete the queued messages in small chunks.
     *
     * A page of history holds up to 100 messages. Deleting them as one block
     * would keep the progress display frozen for the whole chunk and make
     * Cancel unresponsive, so the queue is drained in smaller pieces.
     */
    const drainPending = async () => {
        while (pending.length > 0) {
            if (shouldCancel()) {
                cancelled = true;
                break;
            }

            const chunk = pending.splice(0, Math.min(pending.length, FLUSH_CHUNK));
            const removedIds: string[] = [];
            let index = 0;

            const worker = async () => {
                while (index < chunk.length) {
                    if (shouldCancel()) {
                        cancelled = true;
                        return;
                    }

                    const i = index++;
                    const message = chunk[i];

                    const outcome = await deleteMessage(channelId, message.id, scheduler, counters);

                    if (outcome === "deleted") {
                        counters.deleted++;
                        removedIds.push(message.id);
                    } else if (outcome === "already-gone") {
                        counters.gone++;
                    } else if (outcome === "skipped") {
                        counters.skipped++;
                    } else {
                        counters.failed++;
                    }
                }
            };

            await Promise.all(Array.from({ length: Math.min(concurrency, chunk.length) }, worker));

            // One store update for the whole chunk instead of one per message.
            removeMessagesLocally(channelId, removedIds, removeFromView);

            onProgress(progressSnapshot("deleting", false));
        }
    };

    for (let page = 0; page < MAX_PAGES; page++) {
        if (shouldCancel()) {
            cancelled = true;
            break;
        }

        const query: Record<string, any> = { limit: PAGE_SIZE };
        if (before) query.before = before;

        let messages: DmMessage[];
        try {
            const res = await RestAPI.get({
                url: Constants.Endpoints.MESSAGES(channelId),
                query,
                retries: 2
            });
            messages = res?.body ?? [];
        } catch (err) {
            logger.error("Failed to fetch messages", err);
            throw err;
        }

        if (!Array.isArray(messages) || messages.length === 0) break;

        for (const message of messages) {
            scanned++;

            if (message?.author?.id !== me) continue;

            if (typeof message.type === "number" && UNDELETABLE_MESSAGE_TYPES.has(message.type)) {
                counters.skipped++;
                continue;
            }

            // "Delete this message and my newer ones" only touches the
            // newer half of the history.
            if (anchorId) {
                const anchor = BigInt(anchorId);
                if (BigInt(message.id) < anchor) continue;
            }

            pending.push(message);
            collected++;

            if (options.maxMessages > 0 && collected > options.maxMessages) {
                hitLimit = true;
                pending.pop();
                collected--;
                break;
            }
        }

        onProgress(progressSnapshot(pending.length > 0 ? "deleting" : "scanning", false));

        await drainPending();

        if (hitLimit) break;

        const oldest = messages[messages.length - 1];
        if (!oldest?.id) break;
        before = oldest.id;

        // Ran out of pages without reaching the end of the channel.
        if (page === MAX_PAGES - 1) truncated = true;
    }

    await drainPending();

    onProgress(progressSnapshot("deleting", true));

    return {
        ...counters,
        truncated,
        hitLimit,
        elapsedMs: Date.now() - startTime,
        scanned
    };
}

/**
 * Drop the channel's cached message list so Discord refetches it from the
 * server, so the view ends up matching the server exactly.
 *
 * Discord's own `CLEAR_MESSAGES` action cannot be used here. Its handler
 * calls a store method that is not present in this Discord build, which
 * throws an uncaught TypeError and leaves the channel stuck showing nothing.
 * That is the "Discord stops loading after I use delete all dm" symptom.
 *
 * Instead the channel's entry is dropped straight out of Discord's
 * ChannelMessages store, and the channel is asked to load again. Same
 * result, no error.
 */
function resyncChannel(channelId: string) {
    try {
        const store = findByProps("_channelMessages");
        store?.clear?.(channelId);
    } catch (err) {
        logger.warn("Could not clear the channel cache", err);
    }

    // Ask Discord to load the channel again so the view fills back in.
    try {
        const { loadMessages } = findByProps("loadMessages");
        loadMessages(channelId);
    } catch {
        // Not every build exposes this, the store clear above is the part
        // that matters.
    }
}

function reportRun(result: RunResult, maxMessages: number) {
    const parts = [`${result.deleted} message${result.deleted === 1 ? "" : "s"} deleted`];

    if (result.gone > 0) parts.push(`${result.gone} already gone`);
    if (result.skipped > 0) parts.push(`${result.skipped} skipped (Discord refuses to delete some system messages)`);
    if (result.failed > 0) parts.push(`${result.failed} failed`);
    if (result.rateLimited > 0) parts.push(`throttled ${result.rateLimited} times`);
    if (result.hitLimit) parts.push(`stopped at the ${maxMessages} message limit, older messages were left`);
    if (result.truncated) parts.push("this DM is too long to page through completely, some older messages may have been missed");

    const seconds = result.elapsedMs / 1000;
    if (seconds > 1) {
        parts.push(`took ${formatDuration(result.elapsedMs)} (${(result.deleted / seconds).toFixed(1)}/s)`);
    }

    showToast({
        text: parts.join(", "),
        variant: result.failed > 0 || result.truncated ? "critical" : "success"
    });
}

async function deleteAllInChannel(channelId: string, anchorId?: string) {
    const limits = readLimits();
    const maxMessages = Number.isInteger(limits.maxMessages) && limits.maxMessages >= 0 ? limits.maxMessages : 200;
    const concurrency = Math.max(1, Math.min(4, Math.floor(limits.concurrency || DEFAULT_CONCURRENCY)));
    const removeFromView = settings.store.removeFromView;

    let cancelled = false;
    let closeModal: (() => void) | undefined;

    const progress: ProgressState = {
        phase: "scanning",
        scanned: 0,
        total: 0,
        deleted: 0,
        gone: 0,
        skipped: 0,
        failed: 0,
        rateLimited: 0,
        perSecond: 0,
        etaSeconds: null,
        done: false,
        cancelled: false
    };

    const doDelete = async () => {
        const tracker = new ProgressTracker(progress);

        // A modal is shown for the whole run so the user can watch progress
        // and cancel. A toast cannot be updated in place.
        closeModal = openModal(modalProps => (
            <ProgressModal
                modalProps={modalProps}
                tracker={tracker}
                onCancel={() => {
                    cancelled = true;
                }}
            />
        )) as unknown as (() => void);

        let result: RunResult;
        try {
            result = await runBulkDelete({
                channelId,
                maxMessages,
                concurrency,
                removeFromView,
                anchorId,
                onProgress: next => tracker.update(next),
                shouldCancel: () => cancelled
            });
        } catch (err) {
            logger.error("Bulk delete failed", err);
            showToast({ text: "Could not load message history", variant: "critical" });
            closeModal?.();
            return;
        }

        // Reconcile the view with the server once the run is done.
        if (removeFromView) resyncChannel(channelId);

        closeModal?.();
        reportRun(result, maxMessages);
    };

    if (!settings.store.confirmBeforeDelete) {
        void doDelete();
        return;
    }

    void confirmAction({
        title: anchorId ? "Delete this message and your newer ones?" : "Delete all your messages in this DM?",
        subtitle:
            maxMessages > 0
                ? `This will permanently delete up to ${maxMessages} of your messages. Messages older than the limit will be left alone.`
                : "This will permanently delete every message of yours in this DM.",
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
