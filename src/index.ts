import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const CALDAV_BASE = "https://caldav.icloud.com";

interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  ICLOUD_USERNAME: string;
  ICLOUD_APP_PASSWORD: string;
}

function basicAuth(username: string, password: string): string {
  return "Basic " + btoa(`${username}:${password}`);
}

function toCalDAVDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Extract href value from XML - handles both namespaced <D:href> and plain <href> */
function extractHref(xml: string, context?: string): string | null {
  // If context provided, narrow to that section first
  let searchXml = xml;
  if (context) {
    const ctxMatch = new RegExp(`${context}[\\s\\S]*?</[^>]*${context.split(":").pop()}>`, "i").exec(xml);
    if (ctxMatch) searchXml = ctxMatch[0];
  }
  // Match either <D:href> or <href>, capture the value
  const match = searchXml.match(/<(?:[^:>\s]+:)?href[^>]*>\s*([^<\s]+)\s*<\/(?:[^:>\s]+:)?href>/i);
  return match ? match[1].trim() : null;
}

/** Extract href that looks like a path (starts with /) */
function extractPathHref(xml: string): string | null {
  const matches = [...xml.matchAll(/<(?:[^:>\s]+:)?href[^>]*>\s*([^<]+)\s*<\/(?:[^:>\s]+:)?href>/gi)];
  for (const m of matches) {
    const val = m[1].trim();
    if (val.startsWith("/") && val.length > 1) return val;
  }
  return null;
}

async function discoverPrincipal(username: string, password: string): Promise<string> {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop><D:current-user-principal/></D:prop>
</D:propfind>`;

  const res = await fetch(`${CALDAV_BASE}/`, {
    method: "PROPFIND",
    headers: {
      Authorization: basicAuth(username, password),
      "Content-Type": "application/xml; charset=utf-8",
      "Depth": "0",
    },
    body,
  });

  if (res.status === 401) throw new Error("Authentication failed - check ICLOUD_USERNAME and ICLOUD_APP_PASSWORD secrets");
  if (!res.ok) throw new Error(`CalDAV PROPFIND failed: ${res.status} ${res.statusText}`);

  const xml = await res.text();

  // Look for href inside current-user-principal block
  const principalBlock = xml.match(/current-user-principal[\s\S]*?\/[^>]*current-user-principal>/i);
  if (principalBlock) {
    const href = extractPathHref(principalBlock[0]);
    if (href) return href;
  }

  // Fallback: find any path href that looks like a principal (contains /principal/)
  const allHrefs = [...xml.matchAll(/<(?:[^:>\s]+:)?href[^>]*>([^<]+)<\/(?:[^:>\s]+:)?href>/gi)];
  for (const m of allHrefs) {
    const val = m[1].trim();
    if (val.includes("/principal")) return val.startsWith("/") ? val : new URL(val).pathname;
  }

  // Last resort: return the raw XML snippet in error for debugging
  throw new Error(`Could not find principal URL. Response preview: ${xml.substring(0, 500)}`);
}

async function discoverCalendarHome(username: string, password: string, principalUrl: string): Promise<string> {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><C:calendar-home-set/></D:prop>
</D:propfind>`;

  // Strip base URL if it's a full URL
  const path = principalUrl.startsWith("http") ? new URL(principalUrl).pathname : principalUrl;

  const res = await fetch(`${CALDAV_BASE}${path}`, {
    method: "PROPFIND",
    headers: {
      Authorization: basicAuth(username, password),
      "Content-Type": "application/xml; charset=utf-8",
      "Depth": "0",
    },
    body,
  });

  if (!res.ok) throw new Error(`Calendar home PROPFIND failed: ${res.status} ${res.statusText}`);

  const xml = await res.text();

  // Look for href inside calendar-home-set block
  const homeBlock = xml.match(/calendar-home-set[\s\S]*?\/[^>]*calendar-home-set>/i);
  if (homeBlock) {
    const href = extractPathHref(homeBlock[0]);
    if (href) return href;
  }

  // Try all hrefs, pick one that looks like a calendar home (contains /calendars/)
  const allHrefs = [...xml.matchAll(/<(?:[^:>\s]+:)?href[^>]*>([^<]+)<\/(?:[^:>\s]+:)?href>/gi)];
  for (const m of allHrefs) {
    const val = m[1].trim();
    if (val.includes("/calendar")) return val.startsWith("/") ? val : new URL(val).pathname;
  }

  throw new Error(`Could not find calendar home. Response preview: ${xml.substring(0, 500)}`);
}

async function listCalendars(username: string, password: string, calendarHomeUrl: string) {
  const path = calendarHomeUrl.startsWith("http") ? new URL(calendarHomeUrl).pathname : calendarHomeUrl;

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:ICAL="http://apple.com/ns/ical/">
  <D:prop>
    <D:displayname/>
    <C:calendar-description/>
    <ICAL:calendar-color/>
    <C:supported-calendar-component-set/>
    <D:resourcetype/>
  </D:prop>
</D:propfind>`;

  const res = await fetch(`${CALDAV_BASE}${path}`, {
    method: "PROPFIND",
    headers: {
      Authorization: basicAuth(username, password),
      "Content-Type": "application/xml; charset=utf-8",
      "Depth": "1",
    },
    body,
  });

  if (!res.ok) throw new Error(`List calendars failed: ${res.status} ${res.statusText}`);

  const xml = await res.text();
  const calendars: Array<{ name: string; url: string; color?: string }> = [];

  // Split by response blocks
  const responseBlocks = xml.split(/<(?:[^:>\s]+:)?response[^>]*>/i).slice(1);

  for (const block of responseBlocks) {
    // Must have calendar resourcetype
    if (!block.toLowerCase().includes("calendar")) continue;
    // Skip if it has collection but no calendar (that's the home itself)
    if (!block.toLowerCase().includes("vevent") && !block.toLowerCase().includes("calendar\">") && !block.toLowerCase().includes("calendar/>")) continue;

    const hrefMatch = block.match(/<(?:[^:>\s]+:)?href[^>]*>([^<]+)<\/(?:[^:>\s]+:)?href>/i);
    const nameMatch = block.match(/<(?:[^:>\s]+:)?displayname[^>]*>([^<]+)<\/(?:[^:>\s]+:)?displayname>/i);

    if (!hrefMatch || !nameMatch) continue;

    const url = hrefMatch[1].trim();
    const name = nameMatch[1].trim();
    if (!name) continue;

    // Convert to path if full URL
    const urlPath = url.startsWith("http") ? new URL(url).pathname : url;
    if (urlPath === path) continue; // skip the home itself

    const colorMatch = block.match(/calendar-color[^>]*>([^<]+)<\/[^>]*calendar-color>/i);

    calendars.push({
      url: urlPath,
      name,
      color: colorMatch ? colorMatch[1].trim() : undefined,
    });
  }

  return calendars;
}

async function getEvents(username: string, password: string, calendarUrl: string, startDate: Date, endDate: Date) {
  const path = calendarUrl.startsWith("http") ? new URL(calendarUrl).pathname : calendarUrl;

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${toCalDAVDate(startDate)}" end="${toCalDAVDate(endDate)}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

  const res = await fetch(`${CALDAV_BASE}${path}`, {
    method: "REPORT",
    headers: {
      Authorization: basicAuth(username, password),
      "Content-Type": "application/xml; charset=utf-8",
      "Depth": "1",
    },
    body,
  });

  if (!res.ok) throw new Error(`Get events failed: ${res.status} ${res.statusText}`);

  const xml = await res.text();
  const events: Array<{ uid: string; summary: string; start: string; end: string; location?: string; description?: string }> = [];

  // Extract all VCALENDAR blocks from calendar-data
  const icalBlocks = xml.match(/BEGIN:VCALENDAR[\s\S]*?END:VCALENDAR/g) || [];

  for (const ical of icalBlocks) {
    const uid = (ical.match(/\r?\nUID:([^\r\n]+)/) || [])[1];
    const summary = (ical.match(/\r?\nSUMMARY:([^\r\n]+)/) || [])[1];
    const dtStart = (ical.match(/\r?\nDTSTART(?:;[^\r\n:]*)?:([^\r\n]+)/) || [])[1];
    const dtEnd = (ical.match(/\r?\nDTEND(?:;[^\r\n:]*)?:([^\r\n]+)/) || [])[1];
    const location = (ical.match(/\r?\nLOCATION:([^\r\n]+)/) || [])[1];
    const desc = (ical.match(/\r?\nDESCRIPTION:([^\r\n]+)/) || [])[1];
    if (!summary) continue;
    events.push({
      uid: uid?.trim() || "unknown",
      summary: summary.trim(),
      start: dtStart?.trim() || "unknown",
      end: dtEnd?.trim() || "unknown",
      location: location?.trim(),
      description: desc?.trim(),
    });
  }

  return events;
}

async function createEvent(username: string, password: string, calendarUrl: string, summary: string, startDate: Date, endDate: Date, location?: string, description?: string): Promise<string> {
  const path = calendarUrl.startsWith("http") ? new URL(calendarUrl).pathname : calendarUrl;
  const uid = crypto.randomUUID();
  const now = toCalDAVDate(new Date());

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Remote MCP Server//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `DTSTART:${toCalDAVDate(startDate)}`,
    `DTEND:${toCalDAVDate(endDate)}`,
    `SUMMARY:${summary}`,
    ...(location ? [`LOCATION:${location}`] : []),
    ...(description ? [`DESCRIPTION:${description}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  const eventUrl = `${path}${uid}.ics`;

  const res = await fetch(`${CALDAV_BASE}${eventUrl}`, {
    method: "PUT",
    headers: {
      Authorization: basicAuth(username, password),
      "Content-Type": "text/calendar; charset=utf-8",
      "If-None-Match": "*",
    },
    body: lines.join("\r\n"),
  });

  if (res.status !== 201 && res.status !== 204) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Event creation failed: ${res.status} ${res.statusText}. ${errBody.substring(0, 200)}`);
  }

  return uid;
}

// ── MCP Agent ────────────────────────────────────────────────────────────────

export class MyMCP extends McpAgent {
  server = new McpServer({ name: "Remote MCP Server", version: "1.0.0" });

  async init() {
    const env = this.env as Env;

    // Calculator tools
    this.server.tool("add", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
      content: [{ type: "text", text: String(a + b) }],
    }));

    this.server.tool(
      "calculate",
      { operation: z.enum(["add", "subtract", "multiply", "divide"]), a: z.number(), b: z.number() },
      async ({ operation, a, b }) => {
        let result: number;
        switch (operation) {
          case "add": result = a + b; break;
          case "subtract": result = a - b; break;
          case "multiply": result = a * b; break;
          case "divide":
            if (b === 0) return { content: [{ type: "text", text: "Error: Cannot divide by zero" }] };
            result = a / b; break;
        }
        return { content: [{ type: "text", text: String(result) }] };
      }
    );

    // Calendar tools
    this.server.tool("list_calendars", {}, async () => {
      try {
        const { ICLOUD_USERNAME: user, ICLOUD_APP_PASSWORD: pass } = env;
        if (!user || !pass) return { content: [{ type: "text", text: "Error: ICLOUD_USERNAME and ICLOUD_APP_PASSWORD secrets are not set." }], isError: true };

        const principal = await discoverPrincipal(user, pass);
        const calHome = await discoverCalendarHome(user, pass, principal);
        const calendars = await listCalendars(user, pass, calHome);

        if (calendars.length === 0) return { content: [{ type: "text", text: `No calendars found. Calendar home: ${calHome}` }] };

        const lines = calendars.map(c => `• ${c.name}${c.color ? ` (${c.color})` : ""}\n  URL path: ${c.url}`);
        return { content: [{ type: "text", text: `Found ${calendars.length} calendar(s):\n\n${lines.join("\n\n")}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    });

    this.server.tool("get_events", {
      calendar_url: z.string().describe("CalDAV path of the calendar from list_calendars, e.g. /123456789/calendars/home/"),
      start_date: z.string().describe("Start date in ISO 8601 format, e.g. 2025-03-01T00:00:00Z"),
      end_date: z.string().describe("End date in ISO 8601 format, e.g. 2025-03-31T23:59:59Z"),
    }, async ({ calendar_url, start_date, end_date }) => {
      try {
        const start = new Date(start_date);
        const end = new Date(end_date);
        if (isNaN(start.getTime()) || isNaN(end.getTime())) return { content: [{ type: "text", text: "Error: Invalid date format" }], isError: true };
        const events = await getEvents(env.ICLOUD_USERNAME, env.ICLOUD_APP_PASSWORD, calendar_url, start, end);
        if (events.length === 0) return { content: [{ type: "text", text: `No events found between ${start_date} and ${end_date}.` }] };
        const lines = events.map(e => `📅 ${e.summary}\n   Start: ${e.start}\n   End:   ${e.end}${e.location ? `\n   Location: ${e.location}` : ""}${e.description ? `\n   Notes: ${e.description}` : ""}`);
        return { content: [{ type: "text", text: `Found ${events.length} event(s):\n\n${lines.join("\n\n")}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    });

    this.server.tool("create_event", {
      calendar_url: z.string().describe("CalDAV path from list_calendars"),
      summary: z.string().describe("Event title"),
      start_date: z.string().describe("Start datetime in ISO 8601, e.g. 2025-03-15T10:00:00Z"),
      end_date: z.string().describe("End datetime in ISO 8601, e.g. 2025-03-15T11:00:00Z"),
      location: z.string().optional().describe("Optional location"),
      description: z.string().optional().describe("Optional notes"),
    }, async ({ calendar_url, summary, start_date, end_date, location, description }) => {
      try {
        const start = new Date(start_date);
        const end = new Date(end_date);
        if (isNaN(start.getTime()) || isNaN(end.getTime())) return { content: [{ type: "text", text: "Error: Invalid date format" }], isError: true };
        const uid = await createEvent(env.ICLOUD_USERNAME, env.ICLOUD_APP_PASSWORD, calendar_url, summary, start, end, location, description);
        return { content: [{ type: "text", text: `✅ Event created!\n\nTitle: ${summary}\nStart: ${start_date}\nEnd:   ${end_date}${location ? `\nLocation: ${location}` : ""}${description ? `\nNotes: ${description}` : ""}\nUID: ${uid}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    });
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") return MyMCP.serve("/mcp").fetch(request, env, ctx);

    // Debug endpoint: GET /debug-caldav to test raw CalDAV connection
    if (url.pathname === "/debug-caldav") {
      return (async () => {
        const user = env.ICLOUD_USERNAME;
        const pass = env.ICLOUD_APP_PASSWORD;
        if (!user || !pass) return new Response("Secrets not set", { status: 500 });
        try {
          const body = `<?xml version="1.0" encoding="UTF-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>`;
          const res = await fetch(`${CALDAV_BASE}/`, {
            method: "PROPFIND",
            headers: { Authorization: basicAuth(user, pass), "Content-Type": "application/xml; charset=utf-8", "Depth": "0" },
            body,
          });
          const text = await res.text();
          return new Response(`Status: ${res.status}\n\n${text}`, { headers: { "Content-Type": "text/plain" } });
        } catch (e) {
          return new Response(`Error: ${e}`, { status: 500 });
        }
      })();
    }

    return new Response("Not found", { status: 404 });
  },
};
