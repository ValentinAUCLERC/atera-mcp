import { z } from "zod";
import { compact, definedOnly, listPage, normalizeQuery, scanPages, textIncludes } from "../format.js";
import { alertSeverity, defineTool, id, pagination, scanOptions } from "./common.js";

export const AGENT_SUMMARY = [
  "AgentID",
  "DeviceGuid",
  "MachineName",
  "AgentName",
  "CustomerID",
  "CustomerName",
  "FolderName",
  "DeviceType",
  "OS",
  "Online",
  "LastSeen",
  "LastLoginUser",
  "CurrentLoggedUsers",
  "IpAddresses",
  "ReportedFromIP",
  "Monitored",
] as const;

export const agentTools = [
  defineTool({
    name: "list_agents",
    title: "List agents (devices)",
    description:
      "List monitored machines (Atera agents): name, customer, OS, online status, last seen, logged-in user. Optionally only one customer.",
    toolset: "agents",
    access: "read",
    input: {
      customerId: z.number().int().positive().optional().describe("Only agents of this customer"),
      ...pagination,
    },
    handler: (args, client) =>
      listPage(
        client,
        args.customerId !== undefined ? `/agents/customer/${args.customerId}` : "/agents",
        args,
        AGENT_SUMMARY,
      ),
  }),

  defineTool({
    name: "find_agents",
    title: "Find agents",
    description:
      "Search agents by machine name, logged-in user, IP or customer name (contains, case-insensitive), optionally only offline/online ones. For an exact machine name prefer get_agent_by_machine.",
    toolset: "agents",
    access: "read",
    input: {
      query: z.string().optional().describe("Part of machine name, agent name, user, IP or customer name"),
      customerId: z.number().int().positive().optional(),
      online: z.boolean().optional().describe("true = online only, false = offline only"),
      ...scanOptions,
    },
    handler: (args, client) => {
      if (!args.query && args.customerId === undefined && args.online === undefined) {
        throw new Error("Provide at least one filter: query, customerId or online.");
      }
      const q = args.query ? normalizeQuery(args.query) : null;
      return scanPages(
        client,
        args.customerId !== undefined ? `/agents/customer/${args.customerId}` : "/agents",
        (a) => {
          if (args.online !== undefined && Boolean(a.Online) !== args.online) return false;
          if (q === null) return true;
          const ips = Array.isArray(a.IpAddresses) ? a.IpAddresses.join(" ") : "";
          return [a.MachineName, a.AgentName, a.LastLoginUser, a.CurrentLoggedUsers, a.CustomerName, a.ReportedFromIP, ips].some(
            (v) => textIncludes(v, q),
          );
        },
        { limit: args.limit ?? 20, maxPages: args.maxPages ?? 10, fields: AGENT_SUMMARY },
      );
    },
  }),

  defineTool({
    name: "get_agent",
    title: "Get an agent",
    description: "Full agent record: hardware, OS, Office, disks, battery, IP/MAC addresses, last reboot…",
    toolset: "agents",
    access: "read",
    input: { agentId: id("Agent") },
    handler: async (args, client) => compact(await client.get(`/agents/${args.agentId}`)),
  }),

  defineTool({
    name: "get_agent_by_machine",
    title: "Get agents by machine name",
    description: "Agents whose machine name is exactly this one (Atera lookup).",
    toolset: "agents",
    access: "read",
    input: { machineName: z.string().min(1), ...pagination },
    handler: (args, client) =>
      listPage(client, `/agents/machine/${encodeURIComponent(args.machineName)}`, args, AGENT_SUMMARY),
  }),

  defineTool({
    name: "get_agent_patches",
    title: "Get agent patches",
    description: "Installed or available (missing) Windows updates of a device, by DeviceGuid.",
    toolset: "agents",
    access: "read",
    input: {
      deviceGuid: z.string().min(1).describe("DeviceGuid of the agent (see get_agent)"),
      kind: z.enum(["installed", "available"]).describe("installed or available patches"),
    },
    handler: async (args, client) =>
      compact(
        await client.get(
          `/agents/${encodeURIComponent(args.deviceGuid)}/${args.kind === "installed" ? "installed-patches" : "available-patches"}`,
        ),
      ),
  }),

  defineTool({
    name: "delete_agent",
    title: "Delete an agent",
    description: "Remove an agent (device) from Atera. Irreversible: only on explicit request.",
    toolset: "agents",
    access: "delete",
    input: { agentId: id("Agent") },
    handler: async (args, client) => {
      await client.delete(`/agents/${args.agentId}`);
      return { deleted: true, agentId: args.agentId };
    },
  }),
];

export const ALERT_SUMMARY = [
  "AlertID",
  "Title",
  "Severity",
  "AlertCategoryID",
  "Created",
  "DeviceName",
  "DeviceGuid",
  "AgentId",
  "CustomerID",
  "CustomerName",
  "TicketID",
  "Archived",
  "SnoozedEndDate",
  "AlertMessage",
] as const;

const alertStatus = z.enum(["Open", "Resolved", "Snoozed"]);

export const alertTools = [
  defineTool({
    name: "list_alerts",
    title: "List alerts",
    description:
      "List alerts. Status is filtered by Atera; severity, customer and agent filters scan up to maxPages pages.",
    toolset: "alerts",
    access: "read",
    input: {
      status: alertStatus.optional().describe("Open, Resolved or Snoozed"),
      severity: alertSeverity.optional(),
      customerId: z.number().int().positive().optional(),
      agentId: z.number().int().positive().optional(),
      ...pagination,
      ...scanOptions,
    },
    handler: (args, client) => {
      const query = { alertStatus: args.status };
      const fields = args.full ? null : ALERT_SUMMARY;
      if (args.severity === undefined && args.customerId === undefined && args.agentId === undefined) {
        return listPage(client, "/alerts", args, ALERT_SUMMARY, query);
      }
      return scanPages(
        client,
        "/alerts",
        (a) =>
          (args.severity === undefined || a.Severity === args.severity) &&
          (args.customerId === undefined || a.CustomerID === args.customerId) &&
          (args.agentId === undefined || a.AgentId === args.agentId),
        { limit: args.limit ?? 20, maxPages: args.maxPages ?? 10, fields, query },
      );
    },
  }),

  defineTool({
    name: "get_alert",
    title: "Get an alert",
    description: "Full alert record (thresholds, message, related ticket…).",
    toolset: "alerts",
    access: "read",
    input: { alertId: id("Alert") },
    handler: async (args, client) => compact(await client.get(`/alerts/${args.alertId}`)),
  }),

  defineTool({
    name: "create_alert",
    title: "Create an alert",
    description: "Raise a custom alert on a device. Only when the user explicitly asks for it.",
    toolset: "alerts",
    access: "write",
    input: {
      DeviceGuid: z.string().min(1),
      CustomerID: z.number().int().positive(),
      Title: z.string().min(1),
      Severity: alertSeverity.optional(),
      AlertCategoryID: z
        .enum(["Hardware", "Disk", "Availability", "Performance", "Exchange", "General"])
        .optional(),
      AdditionalInfo: z.string().optional(),
      MessageTemplate: z.string().optional(),
      TicketID: z.number().int().positive().optional().describe("Link the alert to this ticket"),
    },
    handler: async (args, client) => {
      const result = await client.post("/alerts", definedOnly(args));
      return { created: true, result: compact(result) };
    },
  }),

  defineTool({
    name: "resolve_alert",
    title: "Resolve an alert",
    description: "Mark an alert as resolved.",
    toolset: "alerts",
    access: "write",
    idempotent: true,
    input: { alertId: id("Alert") },
    handler: async (args, client) => {
      await client.put(`/alerts/${args.alertId}`);
      return { resolved: true, alertId: args.alertId };
    },
  }),

  defineTool({
    name: "delete_alert",
    title: "Delete an alert",
    description: "Permanently delete an alert. Prefer resolve_alert. Only on explicit request.",
    toolset: "alerts",
    access: "delete",
    input: { alertId: id("Alert") },
    handler: async (args, client) => {
      await client.delete(`/alerts/${args.alertId}`);
      return { deleted: true, alertId: args.alertId };
    },
  }),
];
