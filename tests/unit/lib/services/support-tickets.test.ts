/**
 * Tests for `@/lib/services/support-tickets` (rescan-4 slice 7fn).
 * SupportTicket service — read-dominated user/admin facets. Pins:
 *  - **findUserTicket / findUserTicketLean**: the {_id, userId}
 *    filter combined in ONE query (anti-foot-gun: a missing-userId
 *    filter could surface a foreign ticket — both gates baked in
 *    so a route layer that forgets is still safe). Returns null on
 *    not-found AND on foreign (route layer 404s either way).
 *  - listTicketsForUser: filters userId + sort updatedAt:-1
 *    (newest-activity-first), no pagination (assumed small volume)
 *  - **listTicketsForUserSummary projection**: select() drops the
 *    embedded messages array off the wire; computes messageCount
 *    + lastMessage (= messages.at(-1)) per row; updatedAt defaults
 *    to createdAt when absent
 *  - getTicketById / getTicketByIdLean: thin findById; lean variant
 *    used by GET routes that only echo fields
 *  - **listTicketsForAdmin pagination**: page/perPage default 1/20,
 *    both clamped to min 1; **status:'all' → skip status filter**
 *    (not stored as 'all'!); returns {tickets, total, page, perPage,
 *    pages = ceil(total/perPage)}; Promise.all parallelises find +
 *    countDocuments
 *  - countOpenTickets: status $in ['open','in_progress'] (the OPEN_
 *    STATUSES enum is the single source of truth for "active" vs
 *    "closed/resolved" — health card shows this count)
 *  - createSupportTicket / updateTicketByIdAsAdmin: thin model
 *    passthroughs; update uses {new:true} so caller gets the patched
 *    doc back
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const connectDB = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const SupportTicket = vi.hoisted(() => ({
  findOne: vi.fn(),
  find: vi.fn(),
  findById: vi.fn(),
  findByIdAndUpdate: vi.fn(),
  countDocuments: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/models/SupportTicket", () => ({ default: SupportTicket }));

import {
  findUserTicket,
  findUserTicketLean,
  listTicketsForUser,
  listTicketsForUserSummary,
  getTicketById,
  getTicketByIdLean,
  listTicketsForAdmin,
  countOpenTickets,
  createSupportTicket,
  updateTicketByIdAsAdmin,
} from "@/lib/services/support-tickets";

beforeEach(() => {
  connectDB.mockReset();
  Object.values(SupportTicket).forEach((fn) =>
    (fn as ReturnType<typeof vi.fn>).mockReset()
  );
});

// ── helper: chainable lean/sort/select/skip/limit query stub ──────────
function chainQuery(finalResolved: unknown) {
  const q: any = {
    select: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
    then: (resolve: (v: unknown) => void) => resolve(finalResolved),
  };
  return q;
}

describe("findUserTicket — ownership + id baked into one query", () => {
  it("filters by both _id AND userId — foot-gun guard", async () => {
    SupportTicket.findOne.mockResolvedValueOnce({ _id: "T1", userId: "U1" });
    await findUserTicket("T1", "U1");
    expect(SupportTicket.findOne).toHaveBeenCalledWith({
      _id: "T1",
      userId: "U1",
    });
    expect(connectDB).toHaveBeenCalled();
  });

  it("not-found → null (returned verbatim)", async () => {
    SupportTicket.findOne.mockResolvedValueOnce(null);
    const r = await findUserTicket("T1", "U1");
    expect(r).toBeNull();
  });

  it("foreign-ticket simulation → still null (route layer 404s either way)", async () => {
    // Simulate: foreign ticket returns null because (id+userId) filter excludes it
    SupportTicket.findOne.mockResolvedValueOnce(null);
    const r = await findUserTicket("T1", "OTHER_USER");
    expect(r).toBeNull();
  });
});

describe("findUserTicketLean — same gate, lean", () => {
  it("calls .lean() on findOne", async () => {
    const q = { lean: vi.fn().mockResolvedValueOnce({ _id: "T1" }) };
    SupportTicket.findOne.mockReturnValueOnce(q);
    await findUserTicketLean("T1", "U1");
    expect(SupportTicket.findOne).toHaveBeenCalledWith({
      _id: "T1",
      userId: "U1",
    });
    expect(q.lean).toHaveBeenCalled();
  });
});

describe("listTicketsForUser — newest-activity-first", () => {
  it("filters userId + sort updatedAt:-1", async () => {
    const q = { sort: vi.fn().mockResolvedValueOnce([]) };
    SupportTicket.find.mockReturnValueOnce(q);
    await listTicketsForUser("U1");
    expect(SupportTicket.find).toHaveBeenCalledWith({ userId: "U1" });
    expect(q.sort).toHaveBeenCalledWith({ updatedAt: -1 });
  });
});

describe("listTicketsForUserSummary — projection strips messages array", () => {
  const baseTicket = {
    _id: "T1",
    ticketNumber: "TKT-1",
    subject: "Help",
    category: "billing",
    status: "open",
    priority: "high",
    createdAt: new Date("2026-05-01"),
    updatedAt: new Date("2026-05-15"),
  };

  it("emits 5 fields per row + messageCount + lastMessage; select drops messages from wire", async () => {
    const messages = [
      { sender: "user", text: "first" },
      { sender: "admin", text: "second" },
    ];
    const q = chainQuery([{ ...baseTicket, messages }]);
    SupportTicket.find.mockReturnValueOnce(q);

    const rows = await listTicketsForUserSummary("U1");

    expect(SupportTicket.find).toHaveBeenCalledWith({ userId: "U1" });
    expect(q.select).toHaveBeenCalledWith(
      "ticketNumber subject category status priority createdAt updatedAt messages"
    );
    expect(q.sort).toHaveBeenCalledWith({ updatedAt: -1 });
    expect(q.lean).toHaveBeenCalled();

    expect(rows).toHaveLength(1);
    expect(rows[0].messageCount).toBe(2);
    expect(rows[0].lastMessage).toEqual({ sender: "admin", text: "second" });
    expect(rows[0]).not.toHaveProperty("messages");
  });

  it("empty messages → messageCount:0, lastMessage:null", async () => {
    const q = chainQuery([{ ...baseTicket, messages: [] }]);
    SupportTicket.find.mockReturnValueOnce(q);
    const rows = await listTicketsForUserSummary("U1");
    expect(rows[0].messageCount).toBe(0);
    expect(rows[0].lastMessage).toBeNull();
  });

  it("absent messages field → treated as []", async () => {
    const q = chainQuery([{ ...baseTicket }]);
    SupportTicket.find.mockReturnValueOnce(q);
    const rows = await listTicketsForUserSummary("U1");
    expect(rows[0].messageCount).toBe(0);
  });

  it("absent updatedAt falls back to createdAt", async () => {
    const t = { ...baseTicket, messages: [] };
    delete (t as any).updatedAt;
    const q = chainQuery([t]);
    SupportTicket.find.mockReturnValueOnce(q);
    const rows = await listTicketsForUserSummary("U1");
    expect(rows[0].updatedAt).toEqual(baseTicket.createdAt);
  });
});

describe("getTicketById / getTicketByIdLean — thin model passthroughs", () => {
  it("getTicketById: findById; no .lean()", async () => {
    SupportTicket.findById.mockResolvedValueOnce({ _id: "T1" });
    await getTicketById("T1");
    expect(SupportTicket.findById).toHaveBeenCalledWith("T1");
  });

  it("getTicketByIdLean: chains .lean()", async () => {
    const q = { lean: vi.fn().mockResolvedValueOnce({ _id: "T1" }) };
    SupportTicket.findById.mockReturnValueOnce(q);
    await getTicketByIdLean("T1");
    expect(q.lean).toHaveBeenCalled();
  });
});

describe("listTicketsForAdmin — pagination + status filter contract", () => {
  function setupFind(rows: unknown[], total: number) {
    const q = chainQuery(rows);
    SupportTicket.find.mockReturnValueOnce(q);
    SupportTicket.countDocuments.mockResolvedValueOnce(total);
    return q;
  }

  it("defaults: page=1, perPage=20; status absent → no filter applied", async () => {
    const q = setupFind([], 0);
    await listTicketsForAdmin({});
    expect(SupportTicket.find).toHaveBeenCalledWith({});
    expect(SupportTicket.countDocuments).toHaveBeenCalledWith({});
    expect(q.skip).toHaveBeenCalledWith(0);
    expect(q.limit).toHaveBeenCalledWith(20);
  });

  it("status:'open' → applied to BOTH find and countDocuments", async () => {
    setupFind([], 0);
    await listTicketsForAdmin({ status: "open" });
    expect(SupportTicket.find).toHaveBeenCalledWith({ status: "open" });
    expect(SupportTicket.countDocuments).toHaveBeenCalledWith({
      status: "open",
    });
  });

  it("**status:'all' → skipped (NOT stored as 'all')**", async () => {
    setupFind([], 0);
    await listTicketsForAdmin({ status: "all" });
    expect(SupportTicket.find).toHaveBeenCalledWith({});
    expect(SupportTicket.countDocuments).toHaveBeenCalledWith({});
  });

  it("pagination math: page=3 perPage=5 → skip=10 limit=5", async () => {
    const q = setupFind([], 0);
    await listTicketsForAdmin({ page: 3, perPage: 5 });
    expect(q.skip).toHaveBeenCalledWith(10);
    expect(q.limit).toHaveBeenCalledWith(5);
  });

  it("page<1 clamped to 1", async () => {
    const q = setupFind([], 0);
    await listTicketsForAdmin({ page: 0, perPage: 5 });
    expect(q.skip).toHaveBeenCalledWith(0); // (1-1)*5
  });

  it("perPage<1 clamped to 1", async () => {
    const q = setupFind([], 0);
    await listTicketsForAdmin({ page: 1, perPage: 0 });
    expect(q.limit).toHaveBeenCalledWith(1);
  });

  it("result shape: tickets[] + total + page + perPage + pages (ceil)", async () => {
    setupFind([], 21);
    const r = await listTicketsForAdmin({ page: 2, perPage: 10 });
    expect(r.tickets).toEqual([]);
    expect(r.total).toBe(21);
    expect(r.page).toBe(2);
    expect(r.perPage).toBe(10);
    expect(r.pages).toBe(3); // ceil(21/10)
  });

  it("projects messages → messageCount + lastMessage per row; includes userEmail/userName (admin-only fields)", async () => {
    const ticket = {
      _id: "T1",
      ticketNumber: "TKT-1",
      subject: "Help",
      category: "billing",
      status: "open",
      priority: "high",
      userEmail: "u@x.com",
      userName: "User One",
      createdAt: new Date("2026-05-01"),
      updatedAt: new Date("2026-05-15"),
      messages: [{ sender: "user", text: "hi" }],
    };
    setupFind([ticket], 1);
    const r = await listTicketsForAdmin({});
    expect(r.tickets[0].userEmail).toBe("u@x.com");
    expect(r.tickets[0].userName).toBe("User One");
    expect(r.tickets[0].messageCount).toBe(1);
    expect(r.tickets[0].lastMessage).toEqual({ sender: "user", text: "hi" });
    expect(r.tickets[0]).not.toHaveProperty("messages");
  });

  it("Promise.all parallelises find + countDocuments (both kicked off before await)", async () => {
    setupFind([], 0);
    await listTicketsForAdmin({});
    expect(SupportTicket.find).toHaveBeenCalledTimes(1);
    expect(SupportTicket.countDocuments).toHaveBeenCalledTimes(1);
  });
});

describe("countOpenTickets — OPEN_STATUSES enum is source of truth", () => {
  it("filters status $in ['open','in_progress']", async () => {
    SupportTicket.countDocuments.mockResolvedValueOnce(7);
    const n = await countOpenTickets();
    expect(SupportTicket.countDocuments).toHaveBeenCalledWith({
      status: { $in: ["open", "in_progress"] },
    });
    expect(n).toBe(7);
  });

  it("does NOT include 'resolved' or 'closed'", async () => {
    SupportTicket.countDocuments.mockResolvedValueOnce(0);
    await countOpenTickets();
    const filter = SupportTicket.countDocuments.mock.calls[0][0];
    expect(filter.status.$in).not.toContain("resolved");
    expect(filter.status.$in).not.toContain("closed");
  });
});

describe("createSupportTicket / updateTicketByIdAsAdmin — thin passthroughs", () => {
  it("createSupportTicket: forwards payload to .create()", async () => {
    SupportTicket.create.mockResolvedValueOnce({ _id: "T1" });
    const r = await createSupportTicket({ subject: "Help", userId: "U1" });
    expect(SupportTicket.create).toHaveBeenCalledWith({
      subject: "Help",
      userId: "U1",
    });
    expect(r).toEqual({ _id: "T1" });
  });

  it("updateTicketByIdAsAdmin: findByIdAndUpdate with {new:true} (returns post-update doc)", async () => {
    SupportTicket.findByIdAndUpdate.mockResolvedValueOnce({
      _id: "T1",
      status: "resolved",
    });
    const r = await updateTicketByIdAsAdmin("T1", { status: "resolved" });
    expect(SupportTicket.findByIdAndUpdate).toHaveBeenCalledWith(
      "T1",
      { status: "resolved" },
      { new: true }
    );
    expect(r?.status).toBe("resolved");
  });

  it("updateTicketByIdAsAdmin: not-found → returns null verbatim", async () => {
    SupportTicket.findByIdAndUpdate.mockResolvedValueOnce(null);
    const r = await updateTicketByIdAsAdmin("T1", { status: "resolved" });
    expect(r).toBeNull();
  });
});
