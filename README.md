# atera-mcp

A clean, read-only-by-default [MCP](https://modelcontextprotocol.io) server for the [Atera](https://www.atera.com) RMM/PSA API v3.

- **Ticket statistics over your whole history** (optional): a local SQLite index kept in sync with Atera answers counts, trends, rankings, resolution/first-response times and SLA compliance in milliseconds, over tens of thousands of tickets. See [Ticket index and statistics](#ticket-index-and-statistics).
- **50 tools** over tickets, customers, contacts, agents (devices), alerts, contracts, knowledge base, billing, custom fields, network devices, departments and rates.
- **Every tool is listed from the first `tools/list`.** No "navigate first" step, no hidden state: works with any MCP host, including gateways and shared/pooled processes.
- **Safe by default:** read-only unless you opt in with `ATERA_ACCESS=write` or `full`. Tools carry MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`).
- **Small outputs:** list tools return a summary of each item (`full=true` for every field), null/empty fields are stripped, pages are capped at 50 items.
- **Search helpers** for what Atera can't filter server-side: `find_customers`, `find_contacts`, `find_agents`, severity/customer/agent filters on alerts, text search in the knowledge base.
- **Robust client:** JWT keys sent as `Bearer`, legacy keys as `X-API-KEY`; retries reads on 429/5xx/network errors (honours `Retry-After`) but never replays a write that may have reached Atera; errors come back as a JSON envelope the model can act on.
- 2 runtime dependencies: `@modelcontextprotocol/sdk` and `zod`.

## Quick start

You need Node.js 20+ (22.13+ for the ticket index) and an Atera API key (Atera → **Admin → API**). Prefer a key with **read** permissions only, unless you enable write tools.

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

Pin a version with `atera-mcp@0.2.1`. Without npm access, the tarball attached to each GitHub release works too, and so does git (slower: it builds on install):

```bash
npx -y https://github.com/ValentinAUCLERC/atera-mcp/releases/download/v0.2.1/atera-mcp-0.2.1.tgz
npx -y github:ValentinAUCLERC/atera-mcp#v0.2.1
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
| `ATERA_ACCESS` | `read` | `read` = read tools only (32, +3 stats tools with the index), `write` = + create/update/comment/resolve (+10), `full` = + delete (+5). |
| `ATERA_TOOLSETS` | all | Comma-separated subset to expose fewer tools: `account, customers, contacts, agents, alerts, tickets, stats, contracts, knowledge, billing, customfields, devices, departments, rates`. |
| `ATERA_TIMEOUT_MS` | `30000` | Timeout of one HTTP call to Atera. |
| `ATERA_MAX_RESULT_CHARS` | `25000` | Max size of one tool result. Longer lists are trimmed (whole items, with `itemsOmitted`) instead of being cut mid-JSON by the client. |
| `ATERA_CACHE_DIR` | — (disabled) | Enables the local ticket index and the `stats` tools. Directory for the SQLite file (one file per Atera account). Needs Node.js 22.13+. |
| `ATERA_TIMEZONE` | `UTC` | IANA time zone used for date filters and day/week/month grouping, e.g. `Europe/Paris`. |
| `ATERA_SYNC_RPM` | `300` | Max Atera requests per minute used by the index sync (capped at 600; Atera allows ~700 for the whole account). |
| `ATERA_SYNC_INTERVAL_MIN` | `5` | Incremental sync period (tickets modified since the last sync). |
| `ATERA_SYNC_FULL_MIN` | `60` | Full reconciliation period (re-reads every ticket, removes deleted ones). |
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
| stats | `ticket_stats` | R | Counts, open/resolved, resolution & first-response times, SLA %, work hours; grouped by status, priority, type, source, customer, technician, end user or period (needs the index) |
| stats | `search_tickets` | R | Tickets filtered by date ranges, technician, end user, title, several statuses (needs the index) |
| stats | `ticket_index_status` | R | Index state: tickets indexed, last syncs, progress, last error (needs the index) |
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

## Ticket index and statistics

Atera's API returns at most 50 tickets per call and can only filter tickets by status and customer. Computing statistics by paging through the API from a chat is slow, expensive in tokens and gives wrong numbers. With `ATERA_CACHE_DIR` set, the server keeps a local SQLite copy of every ticket's **metadata** (no comment text) and answers statistics from it.

How it stays up to date:

1. **Initial build**, in the background on first start: walks every page of `/tickets` at `ATERA_SYNC_RPM`. 40,000 tickets = 800 requests ≈ 3 minutes at the default rate. It is resumable: if the process stops, it continues from the last page. Until it completes, the stats tools answer "index being built (page x / y)" instead of failing.
2. **Incremental sync** every `ATERA_SYNC_INTERVAL_MIN`: `/tickets/lastmodified` since the last sync (with a 10-minute overlap). Usually 1 request. A stale index is also refreshed just before answering a question.
3. **Full reconciliation** every `ATERA_SYNC_FULL_MIN`: re-reads everything, which also refreshes fields that do not bump the modification date. A ticket missing from the run is removed only after Atera confirms it is gone (HTTP 404).

After a restart the index is read from disk and caught up incrementally, so keep `ATERA_CACHE_DIR` on persistent storage (a Docker volume). Every answer includes `index.dataAsOf`, the time of the last successful sync.

Sizing (measured on 40,000 synthetic tickets): ~10 MB on disk, aggregates over the whole index in under a second, results of a few KB.

Examples of questions it answers: tickets per month over the last two years; average and median resolution time per technician in 2025; open tickets per customer; first-response SLA compliance last quarter; oldest open tickets.

The index lives in the MCP process: the server must stay up for periodic syncs to run. Hosts that stop idle MCP servers simply resume the sync at the next start. If several processes share the same index file (e.g. an old process still running after a configuration change), a lease stored in the database makes sure only one of them syncs; the others just read.

## Notes and limits

- Atera allows about 700 requests per minute per account. `find_*` tools cost one request per scanned page (10 by default, 40 max). The index sync stays under `ATERA_SYNC_RPM`.
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
