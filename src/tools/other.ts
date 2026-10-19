import { z } from "zod";
import { compact, listPage, normalizeQuery, scanPages, textIncludes } from "../format.js";
import { defineTool, id, pagination, scanOptions } from "./common.js";

const CONTRACT_SUMMARY = [
  "ContractID",
  "ContractName",
  "ContractType",
  "CustomerID",
  "CustomerName",
  "Active",
  "Default",
  "StartDate",
  "EndDate",
] as const;

const KB_SUMMARY = [
  "KBID",
  "KBProduct",
  "KBKeywords",
  "CategoryName",
  "SectionName",
  "KBContext",
  "KBIsPrivate",
  "KBLastModified",
] as const;

const INVOICE_SUMMARY = [
  "InvoiceNumber",
  "InvoiceNumberAsString",
  "InvoiceDate",
  "ContractName",
  "PeriodStartDate",
  "PeriodEndDate",
  "Subtotal",
  "Tax",
  "Total",
  "Currency",
  "IsAdhoc",
] as const;

const CUSTOM_ENTITIES = {
  ticket: "ticket",
  customer: "customer",
  contact: "contact",
  contract: "contract",
  sla: "sla",
  agent: "agent",
  snmp: "snmp",
  tcp: "tcp",
  http: "http",
  generic: "generic",
} as const;

const customEntity = z
  .enum(Object.keys(CUSTOM_ENTITIES) as [keyof typeof CUSTOM_ENTITIES, ...(keyof typeof CUSTOM_ENTITIES)[]])
  .describe("Entity type that owns the custom field");

const DEVICE_TYPES = {
  generic: { list: "/devices/genericdevices", one: "/devices/genericdevice" },
  tcp: { list: "/devices/tcpdevices", one: "/devices/tcpdevice" },
  snmp: { list: "/devices/snmpdevices", one: "/devices/snmpdevice" },
  http: { list: "/devices/httpdevices", one: "/devices/httpdevice" },
} as const;

const deviceType = z
  .enum(["generic", "tcp", "snmp", "http"])
  .describe("Network device kind: generic, tcp, snmp or http");

export const otherTools = [
  defineTool({
    name: "get_account",
    title: "Get Atera account",
    description: "The Atera account behind the API key: company, plan, time zone.",
    toolset: "account",
    access: "read",
    input: {},
    handler: async (_args, client) => compact(await client.get("/account")),
  }),

  defineTool({
    name: "list_contracts",
    title: "List contracts",
    description: "Customer contracts (retainer, block hours, hourly…), optionally for one customer.",
    toolset: "contracts",
    access: "read",
    input: { customerId: z.number().int().positive().optional(), ...pagination },
    handler: (args, client) =>
      listPage(
        client,
        args.customerId !== undefined ? `/contracts/customer/${args.customerId}` : "/contracts",
        args,
        CONTRACT_SUMMARY,
      ),
  }),

  defineTool({
    name: "get_contract",
    title: "Get a contract",
    description: "Full contract record, including rates and included hours.",
    toolset: "contracts",
    access: "read",
    input: { contractId: id("Contract") },
    handler: async (args, client) => compact(await client.get(`/contracts/${args.contractId}`)),
  }),

  defineTool({
    name: "list_kb_articles",
    title: "List knowledge base articles",
    description:
      "Knowledge base articles. With query, scans articles whose product, keywords, category, section or content contains it.",
    toolset: "knowledge",
    access: "read",
    input: {
      query: z.string().optional().describe("Text to look for (case-insensitive)"),
      ...pagination,
      ...scanOptions,
    },
    handler: (args, client) => {
      if (!args.query) return listPage(client, "/knowledgebases", args, KB_SUMMARY);
      const q = normalizeQuery(args.query);
      return scanPages(
        client,
        "/knowledgebases",
        (a) =>
          [a.KBProduct, a.KBKeywords, a.CategoryName, a.SectionName, a.KBContext].some((v) => textIncludes(v, q)),
        { limit: args.limit ?? 20, maxPages: args.maxPages ?? 10, fields: args.full ? null : KB_SUMMARY },
      );
    },
  }),

  defineTool({
    name: "list_invoices",
    title: "List invoices",
    description: "Billing invoices (number, date, contract, totals).",
    toolset: "billing",
    access: "read",
    input: { ...pagination },
    handler: (args, client) => listPage(client, "/billing/invoices", args, INVOICE_SUMMARY),
  }),

  defineTool({
    name: "get_invoice",
    title: "Get an invoice",
    description: "Full invoice with line items, issuer and recipient.",
    toolset: "billing",
    access: "read",
    input: { invoiceNumber: z.number().int().positive() },
    handler: async (args, client) => compact(await client.get(`/billing/invoice/${args.invoiceNumber}`)),
  }),

  defineTool({
    name: "list_custom_field_definitions",
    title: "List custom field definitions",
    description: "Custom fields defined in Atera: name, data type, target entity and allowed values.",
    toolset: "customfields",
    access: "read",
    input: {},
    handler: async (_args, client) => compact(await client.get("/customvalues/customfields")),
  }),

  defineTool({
    name: "get_custom_fields",
    title: "Get custom field values",
    description: "Custom field values of one entity (all fields, or a single one with fieldName).",
    toolset: "customfields",
    access: "read",
    input: {
      entity: customEntity,
      entityId: id("Entity"),
      fieldName: z.string().min(1).optional().describe("Only this custom field"),
    },
    handler: async (args, client) => {
      const e = CUSTOM_ENTITIES[args.entity];
      const path = args.fieldName
        ? `/customvalues/${e}field/${args.entityId}/${encodeURIComponent(args.fieldName)}`
        : `/customvalues/${e}fields/${args.entityId}`;
      return compact(await client.get(path));
    },
  }),

  defineTool({
    name: "set_custom_field",
    title: "Set a custom field value",
    description: "Set one custom field value of an entity. Only when the user explicitly asks for it.",
    toolset: "customfields",
    access: "write",
    idempotent: true,
    input: {
      entity: customEntity,
      entityId: id("Entity"),
      fieldName: z.string().min(1),
      value: z.string().describe("New value, as text"),
    },
    handler: async (args, client) => {
      const e = CUSTOM_ENTITIES[args.entity];
      const result = await client.put(
        `/customvalues/${e}field/${args.entityId}/${encodeURIComponent(args.fieldName)}`,
        { Value: args.value },
      );
      return { updated: true, entity: args.entity, entityId: args.entityId, fieldName: args.fieldName, result: compact(result) };
    },
  }),

  defineTool({
    name: "list_devices",
    title: "List network devices",
    description: "Network-monitored devices (generic, TCP, SNMP or HTTP) — not the agents installed on machines.",
    toolset: "devices",
    access: "read",
    input: { type: deviceType, ...pagination },
    handler: (args, client) =>
      listPage(client, DEVICE_TYPES[args.type].list, { ...args, full: true }, []),
  }),

  defineTool({
    name: "get_device",
    title: "Get a network device",
    description: "One network-monitored device.",
    toolset: "devices",
    access: "read",
    input: { type: deviceType, deviceId: id("Device") },
    handler: async (args, client) => compact(await client.get(`${DEVICE_TYPES[args.type].one}/${args.deviceId}`)),
  }),

  defineTool({
    name: "list_departments",
    title: "List departments",
    description: "Customer departments.",
    toolset: "departments",
    access: "read",
    input: { ...pagination },
    handler: (args, client) => listPage(client, "/departments", { ...args, full: true }, []),
  }),

  defineTool({
    name: "get_department",
    title: "Get a department",
    description: "One department.",
    toolset: "departments",
    access: "read",
    input: { departmentId: id("Department") },
    handler: async (args, client) => compact(await client.get(`/departments/${args.departmentId}`)),
  }),

  defineTool({
    name: "list_rates",
    title: "List billing rates",
    description: "Billing rates: products or expenses.",
    toolset: "rates",
    access: "read",
    input: { kind: z.enum(["products", "expenses"]), ...pagination },
    handler: (args, client) => listPage(client, `/rates/${args.kind}`, { ...args, full: true }, []),
  }),
];
