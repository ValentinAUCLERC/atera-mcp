import { z } from "zod";
import { AteraApiError } from "../client.js";
import { compact, definedOnly, listPage } from "../format.js";
import {
  type ToolContext,
  defineTool,
  id,
  pagination,
  ticketImpact,
  ticketPriority,
  ticketStatus,
  ticketType,
} from "./common.js";

export const TICKET_SUMMARY = [
  "TicketID",
  "TicketNumber",
  "TicketTitle",
  "TicketStatus",
  "TicketPriority",
  "TicketImpact",
  "TicketType",
  "TicketSource",
  "CustomerID",
  "CustomerName",
  "EndUserID",
  "EndUserFirstName",
  "EndUserLastName",
  "EndUserEmail",
  "TechnicianContactID",
  "TechnicianFullName",
  "TicketCreatedDate",
  "TicketResolvedDate",
  "LastEndUserCommentTimestamp",
  "LastTechnicianCommentTimestamp",
] as const;

const COMMENT_FIELDS = ["Date", "FirstName", "LastName", "Email", "IsInternal", "Comment", "EndUserID", "TechnicianContactID"] as const;

const TIME_ENTRY_FIELDS = [
  "WorkHoursID",
  "StartWorkHour",
  "EndWorkHour",
  "TechnicianFullName",
  "TechnicianEmail",
  "Billiable",
  "OnCustomerSite",
  "Description",
  "RateAmount",
] as const;

const ticketWritableFields = {
  TicketTitle: z.string().min(1).optional().describe("Ticket title"),
  TicketStatus: ticketStatus.optional(),
  TicketPriority: ticketPriority.optional(),
  TicketImpact: ticketImpact.optional(),
  TicketType: ticketType.optional(),
  TechnicianContactID: z.number().int().positive().optional().describe("Assign to this technician (contact ID)"),
  TechnicianEmail: z.string().email().optional().describe("Assign to the technician with this email"),
};

export const ticketTools = [
  defineTool({
    name: "list_tickets",
    title: "List tickets",
    description:
      "List tickets (summary: number, title, status, priority, customer, end user, technician, dates). Filter by status and/or customer. Newest first is not guaranteed: use list_modified_tickets for recent activity.",
    toolset: "tickets",
    access: "read",
    input: {
      ticketStatus: ticketStatus.optional(),
      customerId: z.number().int().positive().optional().describe("Only tickets of this customer"),
      includeRelations: z.boolean().optional().describe("Include parent/child ticket relations"),
      ...pagination,
    },
    handler: (args, client) =>
      listPage(client, "/tickets", args, TICKET_SUMMARY, {
        ticketStatus: args.ticketStatus,
        customerId: args.customerId,
        includeRelations: args.includeRelations,
      }),
  }),

  defineTool({
    name: "list_modified_tickets",
    title: "List recently modified tickets",
    description:
      'Tickets modified since a date ("last_modified", default) or whose status changed ("status_modified"). Good for "what happened today / since Monday".',
    toolset: "tickets",
    access: "read",
    input: {
      mode: z.enum(["last_modified", "status_modified"]).optional().describe("Default last_modified"),
      since: z
        .string()
        .optional()
        .describe("ISO 8601 date or date-time in UTC (last_modified only; Atera defaults to today)"),
      includeComments: z.boolean().optional().describe("Include first/last comments of each ticket"),
      ...pagination,
    },
    handler: (args, client) => {
      const statusMode = args.mode === "status_modified";
      const fields = args.includeComments
        ? [...TICKET_SUMMARY, "FirstComment", "LastEndUserComment", "LastTechnicianComment"]
        : TICKET_SUMMARY;
      return listPage(client, statusMode ? "/tickets/statusmodified" : "/tickets/lastmodified", args, fields, {
        date: statusMode ? undefined : args.since,
        includeComments: args.includeComments ?? false,
      });
    },
  }),

  defineTool({
    name: "get_ticket",
    title: "Get a ticket",
    description:
      "Full ticket record: description (first comment), last end-user and technician comments, SLA dates and durations.",
    toolset: "tickets",
    access: "read",
    input: {
      ticketId: id("Ticket"),
      includeRelations: z.boolean().optional(),
    },
    handler: async (args, client) =>
      compact(await client.get(`/tickets/${args.ticketId}`, { includeRelations: args.includeRelations })),
  }),

  defineTool({
    name: "list_ticket_comments",
    title: "List ticket comments",
    description: "Conversation of a ticket: author, date, internal flag and text of each comment.",
    toolset: "tickets",
    access: "read",
    input: { ticketId: id("Ticket"), ...pagination },
    handler: (args, client) =>
      listPage(client, `/tickets/${args.ticketId}/comments`, args, COMMENT_FIELDS),
  }),

  defineTool({
    name: "get_ticket_work_hours",
    title: "Get ticket work hours",
    description:
      "Time spent on a ticket: billable / non-billable totals, plus the individual time entries when entries=true.",
    toolset: "tickets",
    access: "read",
    input: {
      ticketId: id("Ticket"),
      entries: z.boolean().optional().describe("Also list each time entry (default false)"),
      page: pagination.page,
      itemsInPage: pagination.itemsInPage,
    },
    handler: async (args, client) => {
      const summary = compact(await client.get(`/tickets/${args.ticketId}/workhours`));
      if (!args.entries) return { summary };
      const records = await listPage(
        client,
        `/tickets/${args.ticketId}/workhoursrecords`,
        args,
        TIME_ENTRY_FIELDS,
      );
      return { summary, entries: records };
    },
  }),

  defineTool({
    name: "list_ticket_attachments",
    title: "List ticket attachments",
    description: "Attachments of a ticket (names and links as returned by Atera).",
    toolset: "tickets",
    access: "read",
    input: { ticketId: id("Ticket") },
    handler: async (args, client) => compact(await client.get(`/tickets/${args.ticketId}/attachments`)),
  }),

  defineTool({
    name: "create_ticket",
    title: "Create a ticket",
    description:
      "Create a ticket. Identify the end user either by EndUserID (existing contact) or by EndUserEmail (+ names). Only when the user explicitly asks for it.",
    toolset: "tickets",
    access: "write",
    input: {
      TicketTitle: z.string().min(1).describe("Ticket title"),
      Description: z.string().min(1).describe("Ticket description (first comment)"),
      EndUserID: z.number().int().positive().optional().describe("Existing contact ID"),
      EndUserEmail: z.string().email().optional(),
      EndUserFirstName: z.string().optional(),
      EndUserLastName: z.string().optional(),
      EndUserPhone: z.string().optional(),
      TicketStatus: ticketStatus.optional(),
      TicketPriority: ticketPriority.optional(),
      TicketImpact: ticketImpact.optional(),
      TicketType: ticketType.optional(),
      TechnicianContactID: ticketWritableFields.TechnicianContactID,
      TechnicianEmail: ticketWritableFields.TechnicianEmail,
    },
    handler: async (args, client) => {
      if (args.EndUserID === undefined && args.EndUserEmail === undefined) {
        throw new Error("Provide EndUserID or EndUserEmail to identify who the ticket is for.");
      }
      const result = await client.post("/tickets", definedOnly(args));
      return { created: true, result: compact(result) };
    },
  }),

  defineTool({
    name: "update_ticket",
    title: "Update a ticket",
    description:
      "Change title, status, priority, impact, type or assigned technician. Omitted fields are left unchanged.",
    toolset: "tickets",
    access: "write",
    idempotent: true,
    input: { ticketId: id("Ticket"), ...ticketWritableFields },
    handler: async ({ ticketId, ...fields }, client) => {
      const body = definedOnly(fields);
      if (Object.keys(body).length === 0) throw new Error("Nothing to update: pass at least one field.");
      const result = await client.post(`/tickets/${ticketId}`, body);
      return { updated: true, ticketId, changes: body, result: compact(result) };
    },
  }),

  defineTool({
    name: "add_ticket_comment",
    title: "Add a ticket comment",
    description:
      "Add a comment to a ticket as a technician. Internal (not visible to the end user) unless internal=false. Only when the user explicitly asks for it. The author is normally set by the server (logged-in user or configured technician): pass technicianId/technicianEmail only if the user names another author.",
    toolset: "tickets",
    access: "write",
    input: {
      ticketId: id("Ticket"),
      comment: z.string().min(1).describe("Comment text"),
      internal: z.boolean().optional().describe("Internal note (default true)"),
      technicianId: z.number().int().positive().optional().describe("Author technician contact ID"),
      technicianEmail: z.string().email().optional().describe("Author technician email"),
    },
    handler: async (args, client, ctx) => {
      const author = commentAuthor(args, ctx);
      const internal = args.internal ?? true;
      const body = {
        CommentText: args.comment,
        TechnicianCommentDetails: definedOnly({ ...author, IsInternal: internal }),
      };
      try {
        const result = await client.post(`/tickets/${args.ticketId}/comments`, body);
        return { added: true, ticketId: args.ticketId, internal, author: authorLabel(author), result: compact(result) };
      } catch (err) {
        // Atera answers 404 "Invalid input" both for an unknown ticket and for an author
        // that is not one of its technicians: say so instead of a bare 404.
        if (err instanceof AteraApiError && err.status === 404) {
          throw new AteraApiError(
            err.status,
            err.code,
            `${err.message}. Atera rejects a comment when the ticket does not exist or when the author (${authorLabel(author)}) is not an Atera technician.`,
            err.retryable,
          );
        }
        throw err;
      }
    },
  }),

  defineTool({
    name: "delete_ticket",
    title: "Delete a ticket",
    description: "Permanently delete a ticket. Irreversible: only on explicit request.",
    toolset: "tickets",
    access: "delete",
    input: { ticketId: id("Ticket") },
    handler: async (args, client) => {
      await client.delete(`/tickets/${args.ticketId}`);
      return { deleted: true, ticketId: args.ticketId };
    },
  }),
];

type CommentAuthor = { TechnicianId?: number; TechnicianEmail?: string };

/**
 * Atera needs an existing technician as author. Order: the user the MCP client says is
 * logged in (cannot be overridden by the model, so a ticket's content can't make it sign
 * as someone else), then the author the model passed, then ATERA_TECHNICIAN_EMAIL.
 */
export function commentAuthor(
  args: { technicianId?: number; technicianEmail?: string },
  ctx: ToolContext,
): CommentAuthor {
  if (ctx.actor?.clientEmail) return { TechnicianEmail: ctx.actor.clientEmail };
  if (args.technicianId !== undefined || args.technicianEmail !== undefined) {
    return definedOnly({ TechnicianId: args.technicianId, TechnicianEmail: args.technicianEmail }) as CommentAuthor;
  }
  if (ctx.actor?.defaultEmail) return { TechnicianEmail: ctx.actor.defaultEmail };
  throw new Error(
    "No comment author: Atera requires an existing technician. Pass technicianEmail (or technicianId), or set ATERA_TECHNICIAN_EMAIL on the server.",
  );
}

function authorLabel(author: CommentAuthor): string {
  return author.TechnicianEmail ?? `technician #${author.TechnicianId}`;
}
