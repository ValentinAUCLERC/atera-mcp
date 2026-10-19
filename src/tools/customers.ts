import { z } from "zod";
import { compact, definedOnly, listPage, normalizeQuery, scanPages, textIncludes } from "../format.js";
import { defineTool, id, pagination, scanOptions } from "./common.js";

export const CUSTOMER_SUMMARY = [
  "CustomerID",
  "CustomerName",
  "Domain",
  "BusinessNumber",
  "City",
  "Country",
  "Phone",
  "LastModified",
] as const;

const customerFields = {
  BusinessNumber: z.string().optional(),
  Domain: z.string().optional().describe("Main email/web domain of the customer"),
  Address: z.string().optional(),
  City: z.string().optional(),
  State: z.string().optional(),
  ZipCodeStr: z.string().optional().describe("Postal code"),
  Country: z.string().optional(),
  Phone: z.string().optional(),
  Fax: z.string().optional(),
  Notes: z.string().optional(),
  Links: z.string().optional().describe("Website or other links"),
};

export const customerTools = [
  defineTool({
    name: "list_customers",
    title: "List customers",
    description: "List customers (ID, name, domain, city, phone). Use find_customers to search by name.",
    toolset: "customers",
    access: "read",
    input: { ...pagination },
    handler: (args, client) => listPage(client, "/customers", args, CUSTOMER_SUMMARY),
  }),

  defineTool({
    name: "find_customers",
    title: "Find customers by name",
    description:
      "Search customers whose name, domain or business number contains the query (case-insensitive). Use it to get a CustomerID from a company name.",
    toolset: "customers",
    access: "read",
    input: {
      query: z.string().min(1).describe("Part of the customer name, domain or business number"),
      ...scanOptions,
    },
    handler: (args, client) => {
      const q = normalizeQuery(args.query);
      return scanPages(
        client,
        "/customers",
        (c) => textIncludes(c.CustomerName, q) || textIncludes(c.Domain, q) || textIncludes(c.BusinessNumber, q),
        { limit: args.limit ?? 20, maxPages: args.maxPages ?? 10, fields: CUSTOMER_SUMMARY },
      );
    },
  }),

  defineTool({
    name: "get_customer",
    title: "Get a customer",
    description: "Full customer record (address, notes, links…).",
    toolset: "customers",
    access: "read",
    input: { customerId: id("Customer") },
    handler: async (args, client) => compact(await client.get(`/customers/${args.customerId}`)),
  }),

  defineTool({
    name: "create_customer",
    title: "Create a customer",
    description: "Create a customer. Only when the user explicitly asks for it.",
    toolset: "customers",
    access: "write",
    input: { CustomerName: z.string().min(1), ...customerFields },
    handler: async (args, client) => {
      const result = await client.post("/customers", definedOnly(args));
      return { created: true, result: compact(result) };
    },
  }),

  defineTool({
    name: "update_customer",
    title: "Update a customer",
    description: "Update customer fields. Omitted fields are left unchanged.",
    toolset: "customers",
    access: "write",
    idempotent: true,
    input: { customerId: id("Customer"), CustomerName: z.string().min(1).optional(), ...customerFields },
    handler: async ({ customerId, ...fields }, client) => {
      const body = definedOnly(fields);
      if (Object.keys(body).length === 0) throw new Error("Nothing to update: pass at least one field.");
      const result = await client.post(`/customers/${customerId}`, body);
      return { updated: true, customerId, changes: body, result: compact(result) };
    },
  }),

  defineTool({
    name: "delete_customer",
    title: "Delete a customer",
    description: "Permanently delete a customer. Irreversible: only on explicit request.",
    toolset: "customers",
    access: "delete",
    input: { customerId: id("Customer") },
    handler: async (args, client) => {
      await client.delete(`/customers/${args.customerId}`);
      return { deleted: true, customerId: args.customerId };
    },
  }),
];

export const CONTACT_SUMMARY = [
  "EndUserID",
  "Firstname",
  "Lastname",
  "Email",
  "Phone",
  "MobilePhone",
  "JobTitle",
  "CustomerID",
  "CustomerName",
  "DepartmentName",
  "IsContactPerson",
  "Archived",
] as const;

const contactFields = {
  Firstname: z.string().optional(),
  Lastname: z.string().optional(),
  JobTitle: z.string().optional(),
  Phone: z.string().optional(),
  MobilePhone: z.string().optional(),
  IsContactPerson: z.boolean().optional().describe("Main contact person of the customer"),
  InIgnoreMode: z.boolean().optional().describe("Ignore emails from this contact"),
  CustomerID: z.number().int().positive().optional(),
  DepartmentID: z.number().int().positive().optional(),
};

export const contactTools = [
  defineTool({
    name: "list_contacts",
    title: "List contacts",
    description: "List contacts (end users). Exact filter by email or phone is done by Atera.",
    toolset: "contacts",
    access: "read",
    input: {
      email: z.string().optional().describe("Exact email"),
      phone: z.string().optional().describe("Exact phone"),
      ...pagination,
    },
    handler: (args, client) =>
      listPage(client, "/contacts", args, CONTACT_SUMMARY, {
        "searchOptions.email": args.email,
        "searchOptions.phone": args.phone,
      }),
  }),

  defineTool({
    name: "find_contacts",
    title: "Find contacts",
    description:
      "Search contacts whose name or email contains the query, optionally restricted to one customer. Use it to get an EndUserID.",
    toolset: "contacts",
    access: "read",
    input: {
      query: z.string().optional().describe("Part of first name, last name or email"),
      customerId: z.number().int().positive().optional().describe("Only contacts of this customer"),
      includeArchived: z.boolean().optional().describe("Include archived contacts (default false)"),
      ...scanOptions,
    },
    handler: (args, client) => {
      if (!args.query && args.customerId === undefined) {
        throw new Error("Provide a query and/or a customerId.");
      }
      const q = args.query ? normalizeQuery(args.query) : null;
      return scanPages(
        client,
        "/contacts",
        (c) => {
          if (args.customerId !== undefined && c.CustomerID !== args.customerId) return false;
          if (!args.includeArchived && c.Archived === true) return false;
          if (q === null) return true;
          const fullName = `${c.Firstname ?? ""} ${c.Lastname ?? ""}`;
          return textIncludes(fullName, q) || textIncludes(c.Email, q);
        },
        { limit: args.limit ?? 20, maxPages: args.maxPages ?? 10, fields: CONTACT_SUMMARY },
      );
    },
  }),

  defineTool({
    name: "get_contact",
    title: "Get a contact",
    description: "Full contact record.",
    toolset: "contacts",
    access: "read",
    input: { contactId: id("Contact (EndUserID)") },
    handler: async (args, client) => compact(await client.get(`/contacts/${args.contactId}`)),
  }),

  defineTool({
    name: "create_contact",
    title: "Create a contact",
    description: "Create a contact for a customer. Only when the user explicitly asks for it.",
    toolset: "contacts",
    access: "write",
    input: { Email: z.string().email(), ...contactFields },
    handler: async (args, client) => {
      const result = await client.post("/contacts", definedOnly(args));
      return { created: true, result: compact(result) };
    },
  }),

  defineTool({
    name: "update_contact",
    title: "Update a contact",
    description: "Update contact fields (or archive it with Archived=true). Omitted fields are left unchanged.",
    toolset: "contacts",
    access: "write",
    idempotent: true,
    input: { contactId: id("Contact (EndUserID)"), Archived: z.boolean().optional(), ...contactFields },
    handler: async ({ contactId, ...fields }, client) => {
      const body = definedOnly(fields);
      if (Object.keys(body).length === 0) throw new Error("Nothing to update: pass at least one field.");
      const result = await client.post(`/contacts/${contactId}`, body);
      return { updated: true, contactId, changes: body, result: compact(result) };
    },
  }),

  defineTool({
    name: "delete_contact",
    title: "Delete a contact",
    description: "Permanently delete a contact. Prefer update_contact with Archived=true. Only on explicit request.",
    toolset: "contacts",
    access: "delete",
    input: { contactId: id("Contact (EndUserID)") },
    handler: async (args, client) => {
      await client.delete(`/contacts/${args.contactId}`);
      return { deleted: true, contactId: args.contactId };
    },
  }),
];
