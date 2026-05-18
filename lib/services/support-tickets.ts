/**
 * SupportTicket service.
 *
 * Reads dominate this collection: user-scoped fetches (which need an
 * ownership gate baked in to avoid a missing-`userId` filter leaking a
 * ticket to the wrong user), and admin paginated list/lookup.
 *
 * Writes — `create` from the user-side ticket-open route and
 * `findByIdAndUpdate` from the admin status/priority change route — stay
 * as direct model access. Each has route-specific validation (subject,
 * attachments, status whitelist) that belongs in the route layer, and the
 * service wrapper would just thinly forward.
 */
import connectDB from "@/lib/mongodb";
import SupportTicket from "@/models/SupportTicket";
import type { ISupportTicket, IMessage } from "@/models/SupportTicket";

const OPEN_STATUSES = ["open", "in_progress"] as const;

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * User-scoped ticket fetch. Combines the id-match with the ownership filter
 * in a single query so a missing-`userId` foot-gun can't surface a foreign
 * ticket. Returns null both when not-found and when foreign — the route
 * layer should 404 in either case.
 */
export async function findUserTicket(
  ticketId: string,
  userId: string
): Promise<ISupportTicket | null> {
  await connectDB();
  return SupportTicket.findOne({ _id: ticketId, userId });
}

/**
 * Lean variant of {@link findUserTicket} — the user GET route returns
 * the ticket straight to the client as JSON and never mutates it, so
 * skipping the Mongoose Document hydration trims response time.
 */
export async function findUserTicketLean(
  ticketId: string,
  userId: string
): Promise<any | null> {
  await connectDB();
  return SupportTicket.findOne({ _id: ticketId, userId }).lean();
}

/**
 * List a user's tickets, newest-activity-first.
 */
export async function listTicketsForUser(
  userId: string
): Promise<ISupportTicket[]> {
  await connectDB();
  return SupportTicket.find({ userId }).sort({ updatedAt: -1 });
}

export interface UserTicketSummary {
  _id: unknown;
  ticketNumber: string;
  subject: string;
  category: string;
  status: string;
  priority: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
  lastMessage: IMessage | null;
}

/**
 * User-dashboard summary list — lean projection, no pagination (assumed
 * small per-user volume), with each row's embedded `messages` collapsed
 * to a `messageCount` + `lastMessage` to keep the JSON payload small.
 * Matches what the admin list returns minus `userEmail` / `userName`.
 */
export async function listTicketsForUserSummary(
  userId: string
): Promise<UserTicketSummary[]> {
  await connectDB();
  const rows = await SupportTicket.find({ userId })
    .select("ticketNumber subject category status priority createdAt updatedAt messages")
    .sort({ updatedAt: -1 })
    .lean();
  return rows.map((t) => {
    // Mongoose adds createdAt via the schema's timestamps option but the
    // ISupportTicket interface doesn't declare it — narrow per-row.
    const ticket = t as unknown as ISupportTicket & { createdAt: Date; updatedAt?: Date };
    const messages = (ticket.messages ?? []) as IMessage[];
    return {
      _id: ticket._id,
      ticketNumber: ticket.ticketNumber,
      subject: ticket.subject,
      category: ticket.category,
      status: ticket.status,
      priority: ticket.priority,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt ?? ticket.createdAt,
      messageCount: messages.length,
      lastMessage: messages.at(-1) ?? null,
    };
  });
}

/**
 * Admin lookup by `_id`. Returns null when not found. The admin GET route
 * uses `.lean()` for response shaping — that's wrapped in
 * {@link getTicketByIdLean}.
 */
export async function getTicketById(
  id: string
): Promise<ISupportTicket | null> {
  await connectDB();
  return SupportTicket.findById(id);
}

/**
 * Lean variant of {@link getTicketById} — admin GET routes that only echo
 * fields back as JSON skip the full Mongoose Document hydration cost.
 */
export async function getTicketByIdLean(id: string): Promise<ISupportTicket | null> {
  await connectDB();
  return SupportTicket.findById(id).lean<ISupportTicket>();
}

export interface AdminTicketListEntry {
  _id: unknown;
  ticketNumber: string;
  subject: string;
  category: string;
  status: string;
  priority: string;
  userEmail: string;
  userName: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
  lastMessage: IMessage | null;
}

export interface AdminTicketListResult {
  tickets: AdminTicketListEntry[];
  total: number;
  page: number;
  perPage: number;
  pages: number;
}

/**
 * Admin paginated list. The filter is intentionally narrow — only the
 * status facet is exposed today since that's the only filter the admin UI
 * supports. Pass `status: "all"` (or omit) to skip the filter.
 *
 * Each row carries `messageCount` and `lastMessage` derived from the
 * embedded `messages` array; the array itself is stripped from the
 * response to keep the wire payload small (the detail view fetches it
 * separately via {@link getTicketByIdLean}).
 */
export async function listTicketsForAdmin(opts: {
  status?: string;
  page?: number;
  perPage?: number;
}): Promise<AdminTicketListResult> {
  await connectDB();
  const page = Math.max(1, opts.page ?? 1);
  const perPage = Math.max(1, opts.perPage ?? 20);
  const filter: Record<string, unknown> = {};
  if (opts.status && opts.status !== "all") filter.status = opts.status;

  const [rows, total] = await Promise.all([
    SupportTicket.find(filter)
      .select(
        "ticketNumber subject category status priority userEmail userName createdAt updatedAt messages"
      )
      .sort({ updatedAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .lean(),
    SupportTicket.countDocuments(filter),
  ]);

  const tickets: AdminTicketListEntry[] = rows.map((t) => {
    const ticket = t as unknown as ISupportTicket & { createdAt: Date; updatedAt?: Date };
    const messages = (ticket.messages ?? []) as IMessage[];
    return {
      _id: ticket._id,
      ticketNumber: ticket.ticketNumber,
      subject: ticket.subject,
      category: ticket.category,
      status: ticket.status,
      priority: ticket.priority,
      userEmail: ticket.userEmail,
      userName: ticket.userName,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt ?? ticket.createdAt,
      messageCount: messages.length,
      lastMessage: messages.at(-1) ?? null,
    };
  });

  return { tickets, total, page, perPage, pages: Math.ceil(total / perPage) };
}

/**
 * Count tickets currently in an active state (open + in_progress) — what
 * the system-health card surfaces as "open support tickets". Encapsulated
 * here so the definition of "open" lives next to the model.
 */
export async function countOpenTickets(): Promise<number> {
  await connectDB();
  return SupportTicket.countDocuments({ status: { $in: [...OPEN_STATUSES] } });
}
