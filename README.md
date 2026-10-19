# atera-mcp

A clean, read-only-by-default [MCP](https://modelcontextprotocol.io) server for the [Atera](https://www.atera.com) RMM/PSA API v3.

- **47 tools** over tickets, customers, contacts, agents (devices), alerts, contracts, knowledge base, billing, custom fields, network devices, departments and rates.
- **Every tool is listed from the first `tools/list`.** No "navigate first" step, no hidden state: works with any MCP host, including gateways and shared/pooled processes.
- **Safe by default:** read-only unless you opt in with `ATERA_ACCESS=write` or `full`. Tools carry MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`).
- **Small outputs:** list tools return a summary of each item (`full=true` for every field), null/empty fields are stripped, pages are capped at 50 items.
- **Search helpers** for what Atera can't filter server-side: `find_customers`, `find_contacts`, `find_agents`, severity/customer/agent filters on alerts, text search in the knowledge base.
- **Robust client:** JWT keys sent as `Bearer`, legacy keys as `X-API-KEY`; retries reads on 429/5xx/network errors (honours `Retry-After`) but never replays a write that may have reached Atera; errors come back as a JSON envelope the model can act on.
- 2 runtime dependencies: `@modelcontextprotocol/sdk` and `zod`.

## Quick start

You need Node.js 20+ and an Atera API key (Atera → **Admin → API**). Prefer a key with **read** permissions only, unless you enable write tools.

```bash
ATERA_API_KEY=your-key npx -y atera-mcp
```

[![npm](https://img.shields.io/npm/v/atera-mcp)](https://www.npmjs.com/package/atera-mcp)

### Claude Desktop / Claude Code / Cursor

```json
{
  "mcpServers": {
    "atera": {
      "command": "npx",
      "args": ["-y", "atera-mcp"],
      "env": {
        "ATERA_API_KEY": "your-key",
        "ATERA_ACCESS": "read"
      }
    }
  }
}
```

Pin a version with `atera-mcp@0.1.1`. Without npm access, the tarball attached to each GitHub release works too, and so does git (slower: it builds on install):

```bash
npx -y https://github.com/ValentinAUCLERC/atera-mcp/releases/download/v0.1.1/atera-mcp-0.1.1.tgz
npx -y github:ValentinAUCLERC/atera-mcp#v0.1.1
```

### From source

```bash
git clone https://github.com/ValentinAUCLERC/atera-mcp.git
cd atera-mcp
npm ci
npm run build
ATERA_API_KEY=your-key node dist/index.js
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `ATERA_API_KEY` | — (required) | Atera API key. JWT tokens are sent as `Authorization: Bearer`, older keys as `X-API-KEY`. |
| `ATERA_ACCESS` | `read` | `read` = read tools only (32), `write` = + create/update/comment/resolve (42), `full` = + delete (47). |
| `ATERA_TOOLSETS` | all | Comma-separated subset to expose fewer tools: `account, customers, contacts, agents, alerts, tickets, contracts, knowledge, billing, customfields, devices, departments, rates`. |
| `ATERA_TIMEOUT_MS` | `30000` | Timeout of one HTTP call to Atera. |
| `ATERA_BASE_URL` | `https://app.atera.com/api/v3` | API base URL (tests, proxies). |

Example for a helpdesk assistant that only needs tickets and who's who:

```bash
ATERA_ACCESS=write ATERA_TOOLSETS=tickets,customers,contacts,agents
```

## Tools

Access: **R** read, **W** write (create/update), **D** delete. W tools need `ATERA_ACCESS=write`, D tools `ATERA_ACCESS=full`.

| Toolset | Tool | Access | What it does |
|---|---|---|---|
| tickets | `list_tickets` | R | Tickets by status and/or customer (summary) |
| tickets | `list_modified_tickets` | R | Tickets modified since a date, or whose status changed |
| tickets | `get_ticket` | R | Full ticket: description, last comments, SLA |
| tickets | `list_ticket_comments` | R | Ticket conversation |
| tickets | `get_ticket_work_hours` | R | Billable / non-billable time, optionally each entry |
| tickets | `list_ticket_attachments` | R | Ticket attachments |
| tickets | `create_ticket` | W | Create a ticket for a contact (ID or email) |
| tickets | `update_ticket` | W | Status, priority, impact, type, title, technician |
| tickets | `add_ticket_comment` | W | Technician comment, internal by default |
| tickets | `delete_ticket` | D | Delete a ticket |
| customers | `list_customers` | R | Customers (summary) |
| customers | `find_customers` | R | Search by name, domain or business number |
| customers | `get_customer` | R | Full customer |
| customers | `create_customer` / `update_customer` | W | Create / update a customer |
| customers | `delete_customer` | D | Delete a customer |
| contacts | `list_contacts` | R | Contacts, exact email/phone filter |
| contacts | `find_contacts` | R | Search by name/email, optionally per customer |
| contacts | `get_contact` | R | Full contact |
| contacts | `create_contact` / `update_contact` | W | Create / update (or archive) a contact |
| contacts | `delete_contact` | D | Delete a contact |
| agents | `list_agents` | R | Monitored machines, optionally per customer |
| agents | `find_agents` | R | Search by machine, user, IP, customer; online/offline filter |
| agents | `get_agent` | R | Full hardware/OS record |
| agents | `get_agent_by_machine` | R | Exact machine name lookup |
| agents | `get_agent_patches` | R | Installed or available Windows updates |
| agents | `delete_agent` | D | Remove an agent |
| alerts | `list_alerts` | R | Alerts by status; severity/customer/agent filters |
| alerts | `get_alert` | R | Full alert |
| alerts | `create_alert` / `resolve_alert` | W | Raise / resolve an alert |
| alerts | `delete_alert` | D | Delete an alert |
| account | `get_account` | R | Account behind the API key |
| contracts | `list_contracts` / `get_contract` | R | Contracts, optionally per customer |
| knowledge | `list_kb_articles` | R | Knowledge base, optional text search |
| billing | `list_invoices` / `get_invoice` | R | Invoices |
| customfields | `list_custom_field_definitions` | R | Custom field definitions |
| customfields | `get_custom_fields` | R | Custom values of a ticket, customer, contact, agent… |
| customfields | `set_custom_field` | W | Set a custom value |
| devices | `list_devices` / `get_device` | R | Network devices (generic, TCP, SNMP, HTTP) |
| departments | `list_departments` / `get_department` | R | Departments |
| rates | `list_rates` | R | Products or expenses rates |

### Output shapes

List tools:

```json
{ "items": [ ... ], "page": 1, "totalPages": 4, "totalItems": 73, "hasMore": true }
```

`find_*` tools (and filtered `list_alerts` / `list_kb_articles`) scan pages of 50 client-side:

```json
{ "items": [ ... ], "scannedPages": 3, "totalPages": 12, "truncated": true }
```

`truncated: true` means the scan stopped before the last page (`limit` reached or `maxPages` hit): there may be more matches.

Errors (`isError: true`):

```json
{ "error": { "code": "not_found", "message": "Atera returned HTTP 404 for GET /tickets/99: ...", "status": 404, "retryable": false } }
```

`code` is one of `invalid_argument`, `unauthorized`, `forbidden`, `not_found`, `rate_limited`, `upstream_error`, `network_error`.

## Notes and limits

- Atera allows about 700 requests per minute per account. `find_*` tools cost one request per scanned page (10 by default, 40 max).
- Updates use Atera's partial update endpoints: only the fields you pass are sent.
- The API key never appears in tool results or logs. Logs go to stderr (stdout is the MCP channel).
- Endpoints and payloads follow Atera's published Swagger for API v3. Some write payloads (ticket comments in particular) are not precisely documented by Atera: if one of them misbehaves on your account, please open an issue with the error envelope.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Tests mock `fetch` and drive the real MCP server through an in-memory transport, so they need no Atera account.

Releases: push a `vX.Y.Z` tag; the release workflow builds, tests, publishes to npm (trusted publishing, with provenance) and attaches `atera-mcp-X.Y.Z.tgz` to the GitHub release.

## License

MIT
