/**
 * Service-layer integration tests for lib/services/support-tickets.ts.
 *
 * Covers the helpers used by the user-facing support endpoint and the
 * admin reply / status workflow.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { clearAllCollections } from "../setup";
import SupportTicket from "@/models/SupportTicket";
import {
  countOpenTickets,
  createSupportTicket,
  findUserTicket,
  findUserTicketLean,
  getTicketById,
  getTicketByIdLean,
  listTicketsForAdmin,
  listTicketsForUser,
  listTicketsForUserSummary,
  updateTicketByIdAsAdmin,
} from "@/lib/services/support-tickets";

const validUserId = () => new mongoose.Types.ObjectId();

function buildTicketPayload(overrides: Record<string, unknown> = {}) {
  const tag = Math.random().toString(36).slice(2, 8);
  const userId = (overrides.userId as mongoose.Types.ObjectId | undefined) ?? validUserId();
  return {
    userId,
    userEmail: `${tag}@user.test`,
    userName: "Test User",
    subject: `Subject ${tag}`,
    category: "other",
    status: "open",
    priority: "medium",
    messages: [
      {
        content: "Initial message",
        authorId: userId,
        authorRole: "user",
        authorName: "Test User",
      },
    ],
    ...overrides,
  };
}

beforeAll(async () => {
  expect(mongoose.connection.readyState).toBe(1);
  await SupportTicket.syncIndexes();
});

beforeEach(clearAllCollections);

describe("createSupportTicket", () => {
  it("inserts a ticket and auto-stamps a unique ticketNumber via the pre-save hook", async () => {
    const userId = validUserId();
    const ticket = await createSupportTicket(buildTicketPayload({ userId }));
    expect(ticket._id).toBeDefined();
    expect(ticket.ticketNumber).toMatch(/^TKT-\d{8}-[A-F0-9]{4}$/);
    expect(ticket.status).toBe("open");
  });
});

describe("getTicketById + getTicketByIdLean", () => {
  it("returns the same row in both hydrated and lean shapes", async () => {
    const t = await createSupportTicket(buildTicketPayload({ subject: "echo" }));
    const hydrated = await getTicketById(String(t._id));
    expect(hydrated?.subject).toBe("echo");
    expect(typeof (hydrated as unknown as { save?: unknown })?.save).toBe("function");

    const lean = await getTicketByIdLean(String(t._id));
    expect(lean?.subject).toBe("echo");
    expect((lean as unknown as { save?: unknown })?.save).toBeUndefined();
  });
});

describe("findUserTicket + findUserTicketLean", () => {
  it("scopes lookups by userId — wrong owner returns null", async () => {
    const owner = validUserId();
    const intruder = validUserId();
    const t = await createSupportTicket(buildTicketPayload({ userId: owner }));

    expect((await findUserTicket(String(t._id), owner))?.userId.toString())
      .toBe(owner.toString());
    expect(await findUserTicket(String(t._id), intruder)).toBeNull();

    const lean = await findUserTicketLean(String(t._id), owner);
    expect(lean?.userEmail).toBeDefined();
  });
});

describe("listTicketsForUser / listTicketsForUserSummary", () => {
  it("returns the user's tickets newest first, scoped to that user", async () => {
    const owner = validUserId();
    const other = validUserId();
    const first = await createSupportTicket(
      buildTicketPayload({ userId: owner, subject: "First" })
    );
    await new Promise((r) => setTimeout(r, 5));
    const second = await createSupportTicket(
      buildTicketPayload({ userId: owner, subject: "Second" })
    );
    await createSupportTicket(buildTicketPayload({ userId: other, subject: "Other" }));

    const full = await listTicketsForUser(String(owner));
    expect(full.map((t) => t._id.toString())).toEqual([
      second._id.toString(),
      first._id.toString(),
    ]);

    const summary = await listTicketsForUserSummary(String(owner));
    expect(summary.map((s) => s.subject)).toEqual(["Second", "First"]);
    // Summary projection should expose ticketNumber + status — fields the
    // user-side list view renders without loading the full messages array.
    expect(summary[0].ticketNumber).toMatch(/^TKT-/);
    expect(summary[0].status).toBe("open");
  });
});

describe("countOpenTickets", () => {
  it("counts only tickets in open + in_progress status", async () => {
    await createSupportTicket(buildTicketPayload({ status: "open" }));
    await createSupportTicket(buildTicketPayload({ status: "in_progress" }));
    await createSupportTicket(buildTicketPayload({ status: "resolved" }));
    await createSupportTicket(buildTicketPayload({ status: "closed" }));
    expect(await countOpenTickets()).toBe(2);
  });
});

describe("listTicketsForAdmin", () => {
  it("paginates and supports status filter", async () => {
    for (let i = 0; i < 5; i++) {
      await createSupportTicket(
        buildTicketPayload({ subject: `A-${i}`, status: "open" })
      );
    }
    for (let i = 0; i < 3; i++) {
      await createSupportTicket(
        buildTicketPayload({ subject: `R-${i}`, status: "resolved" })
      );
    }

    const page1 = await listTicketsForAdmin({ page: 1, perPage: 4 });
    expect(page1.tickets.length).toBe(4);
    expect(page1.total).toBe(8);
    expect(page1.pages).toBe(2);

    const openOnly = await listTicketsForAdmin({ status: "open" });
    expect(openOnly.total).toBe(5);
    expect(openOnly.tickets.every((t) => t.status === "open")).toBe(true);
  });
});

describe("updateTicketByIdAsAdmin", () => {
  it("applies the admin patch and returns the post-update document", async () => {
    const t = await createSupportTicket(buildTicketPayload({ status: "open" }));
    const after = await updateTicketByIdAsAdmin(String(t._id), {
      $set: { status: "in_progress", priority: "high" },
    });
    expect(after?.status).toBe("in_progress");
    expect(after?.priority).toBe("high");
  });

  it("returns null when the id does not match", async () => {
    expect(
      await updateTicketByIdAsAdmin("507f1f77bcf86cd799439011", { $set: { status: "closed" } })
    ).toBeNull();
  });
});
