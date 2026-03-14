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

async function discoverPrincipal(username: string, password: string): Promise<string> {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop><D:current-user-principal/></D:prop>
</D:propfind>`;
  const res = await fetch(`${CALDAV_BASE}/`, {
    method: "PROPFIND",
    headers: { Authorization: basicAuth(username, password), "Content-Type": "application/xml; charset=utf-8", Depth: "0" },
    body,
  });
  if (!res.ok) throw new Error(`PROPFIND failed: ${res.status} ${res.statusText}`);
  const xml = await res.text();
  const match = xml.match(/<[^:]*:href[^>]*>(\/[^<]+)<\/[^:]*:href>/);
  if (!match) throw new Error("Could not find principal URL");
  return match[1];
}

async function discoverCalendarHome(username: string, password: string, principalUrl: string): Promise<string> {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><C:calendar-home-set/></D:prop>
</D:propfind>`;
  const res = await fetch(`${CALDAV_BASE}${principalUrl}`, {
    method: "PROPFIND",
    headers: { Authorization: basicAuth(username, password), "Content-Type": "application/xml; charset=utf-8", Depth: "0" },
    body,
  });
  if (!res.ok) throw new Error(`Calendar home PROPFIND failed: ${res.status}`);
  const xml = await res.text();
  const match = xml.match(/calendar-home-set[\s\S]*?<[^:]*:href[^>]*>(\/[^<]+)<\/[^:]*:href>/);
  if (!match) throw new Error("Could not find calendar home set");
  return match[1];
}

async function listCalendars(username: string, password: string, calendarHomeUrl: string) {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:ICAL="http://apple.com/ns/ical/">
  <D:prop>
    <D:displayname/>
    <C:calendar-description/>
    <ICAL:calendar-color/>
    <C:supported-calendar-component-set/>
  </D:prop>
</D:propfind>`;
  const res = await fetch(`${CALDAV_BASE}${calendarHomeUrl}`, {
    method: "PROPFIND",
    headers: { Authorization: basicAuth(username, password), "Content-Type": "application/xml; charset=utf-8", Depth: "1" },
    body,
  });
  if (!res.ok) throw new Error(`List calendars failed: ${res.status}`);
  const xml = await res.text();
  const calendars: Array<{ name: string; url: string; color?: string }> = [];
  const blocks = xml.match(/<D:response>[\s\S]*?<\/D:response>/g) || [];
  for (const block of blocks) {
    const hrefMatch = block.match(/<D:href[^>]*>(\/[^<]+)<\/D:href>/);
    const nameMatch = block.match(/<D:displayname[^>]*>([^<]+)<\/D:displayname>/);
    if (!hrefMatch || !nameMatch || hrefMatch[1] === calendarHomeUrl) continue;
    if (!block.toLowerCase().includes("calendar")) continue;
    const colorMatch = block.match(/calendar-color[^>]*>#?([A-Fa-f0-9]{6,8})/);
    calendars.push({ url: hrefMatch[1], name: nameMatch[1].trim(), color: colorMatch ? `#${colorMatch[1]}` : undefined });
  }
  return calendars;
}

async function getEvents(username: string, password: string, calendarUrl: string, startDate: Date, endDate: Date) {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${toCalDAVDate(startDate)}" end="${toCalDAVDate(endDate)}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;
  const res = await fetch(`${CALDAV_BASE}${calendarUrl}`, {
    method: "REPORT",
    headers: { Authorization: basicAuth(username, password), "Content-Type": "application/xml; charset=utf-8", Depth: "1" },
    body,
  });
  if (!res.ok) throw new Error(`REPORT failed: ${res.status}`);
  const xml = await res.text();
  const events: Array<{ uid: string; summary: string; start: string; end: string; location?: string; description?: string }> = [];
  const blocks = xml.match(/BEGIN:VCALENDAR[\s\S]*?END:VCALENDAR/g) || [];
  for (const ical of blocks) {
    const uid = (ical.match(/\nUID:([^\r\n]+)/) || [])[1];
    const summary = (ical.match(/\nSUMMARY:([^\r\n]+)/) || [])[1];
    const start = (ical.match(/\nDTSTART[^:]*:([^\r\n]+)/) || [])[1];
    const end = (ical.match(/\nDTEND[^:]*:([^\r\n]+)/) || [])[1];
    const location = (ical.match(/\nLOCATION:([^\r\n]+)/) || [])[1];
    const desc = (ical.match(/\nDESCRIPTION:([^\r\n]+)/) || [])[1];
    if (!summary) continue;
    events.push({ uid: uid?.trim() || "unknown", summary: summary.trim(), start: start?.trim() || "", end: end?.trim() || "", location: location?.trim(), description: desc?.trim() });
  }
  return events;
}

async function createEvent(username: string, password: string, calendarUrl: string, summary: string, startDate: Date, endDate: Date, location?: string, description?: string): Promise<string> {
  const uid = crypto.randomUUID();
  const now = toCalDAVDate(new Date());
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Remote MCP Server//EN", "BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${now}`, `DTSTART:${toCalDAVDate(startDate)}`, `DTEND:${toCalDAVDate(endDate)}`, `SUMMARY:${summary}`, ...(location ? [`LOCATION:${location}`] : []), ...(description ? [`DESCRIPTION:${description}`] : []), "END:VEVENT", "END:VCALENDAR"];
  const icalData = lines.join("\r\n");
  const eventUrl = `${calendarUrl}${uid}.ics`;
  const res = await fetch(`${CALDAV_BASE}${eventUrl}`, {
    method: "PUT",
    headers: { Authorization: basicAuth(username, password), "Content-Type": "text/calendar; charset=utf-8", "If-None-Match": "*" },
    body: icalData,
  });
  if (res.status !== 201 && res.status !== 204) throw new Error(`Event creation failed: ${res.status} ${res.statusText}`);
  return uid;
}

export class MyMCP extends McpAgent {
  server = new McpServer({ name: "Remote MCP Server", version: "1.0.0" });

  async init() {
    const env = this.env as Env;

    this.server.tool("add", { a: z.number(), b: z.number() }, async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }));

    this.server.tool("calculate", { operation: z.enum(["add", "subtract", "multiply", "divide"]), a: z.number(), b: z.number() }, async ({ operation, a, b }) => {
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
    });

    this.server.tool("list_calendars", {}, async () => {
      try {
        const principal = await discoverPrincipal(env.ICLOUD_USERNAME, env.ICLOUD_APP_PASSWORD);
        const calHome = await discoverCalendarHome(env.ICLOUD_USERNAME, env.ICLOUD_APP_PASSWORD, principal);
        const calendars = await listCalendars(env.ICLOUD_USERNAME, env.ICLOUD_APP_PASSWORD, calHome);
        if (calendars.length === 0) return { content: [{ type: "text", text: "No calendars found." }] };
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
      calendar_url: z.string().describe("CalDAV path of the calendar to add the event to (from list_calendars)"),
      summary: z.string().describe("Title/name of the event"),
      start_date: z.string().describe("Start datetime in ISO 8601 format, e.g. 2025-03-15T10:00:00Z"),
      end_date: z.string().describe("End datetime in ISO 8601 format, e.g. 2025-03-15T11:00:00Z"),
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
    return new Response("Not found", { status: 404 });
  },
};
