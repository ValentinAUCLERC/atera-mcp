import { z } from "zod";
import type { AteraClient } from "../client.js";
import type { Toolset } from "../config.js";
import { MAX_ITEMS_IN_PAGE } from "../format.js";

/** read = no side effect, write = create/update, delete = irreversible removal. */
export type ToolAccess = "read" | "write" | "delete";

export type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  toolset: Toolset;
  access: ToolAccess;
  /** Updating the same thing twice gives the same result (PUT-like). */
  idempotent?: boolean;
  input: z.ZodRawShape;
  handler: (args: any, client: AteraClient) => Promise<unknown>;
};

export function defineTool<S extends z.ZodRawShape>(def: {
  name: string;
  title: string;
  description: string;
  toolset: Toolset;
  access: ToolAccess;
  idempotent?: boolean;
  input: S;
  handler: (args: z.infer<z.ZodObject<S>>, client: AteraClient) => Promise<unknown>;
}): ToolDefinition {
  return def as ToolDefinition;
}

export const id = (what: string) => z.number().int().positive().describe(`${what} ID`);

export const pagination = {
  page: z.number().int().min(1).optional().describe("Page number, starting at 1 (default 1)"),
  itemsInPage: z
    .number()
    .int()
    .min(1)
    .max(MAX_ITEMS_IN_PAGE)
    .optional()
    .describe(`Items per page (default 20, max ${MAX_ITEMS_IN_PAGE})`),
  full: z
    .boolean()
    .optional()
    .describe("Return every field of each item instead of a summary (much larger output)"),
};

export const scanOptions = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum number of matches to return (default 20)"),
  maxPages: z
    .number()
    .int()
    .min(1)
    .max(40)
    .optional()
    .describe("Maximum pages of 50 items to scan (default 10, i.e. 500 records)"),
};

export const ticketPriority = z.enum(["Low", "Medium", "High", "Critical"]);
export const ticketImpact = z.enum(["NoImpact", "SiteDown", "ServerIssue", "Minor", "Major", "Crisis"]);
export const ticketType = z.enum(["Incident", "Problem", "Request", "Change"]);
export const ticketStatus = z
  .string()
  .min(1)
  .describe('Ticket status, e.g. "Open", "Pending", "Resolved", "Closed" (custom statuses are allowed)');
export const alertSeverity = z.enum(["Information", "Warning", "Critical"]);
