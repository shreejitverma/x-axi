// Serves the built MCP server over stdio with a test approver and a fixed login, for the end-to-end tests.
// It changes only what `x-axi mcp` injects; the server, the tools, and the command layer are the built ones.
// X_AXI_API_BASE must point at loopback, so the HTTP client sends the fixed test token there and never reads a keystore.
import { appendFileSync } from "node:fs";
import { createHttpClient } from "../../dist/src/api.js";
import { serveMcp } from "../../dist/src/mcp.js";

if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.X_AXI_API_BASE ?? "")) throw new Error("the fixture runs only against a loopback X_AXI_API_BASE");

const answer = process.env.FIXTURE_APPROVAL ?? "cancelled";
const holdMs = Number(process.env.FIXTURE_APPROVAL_MS ?? 0);
const log = process.env.FIXTURE_APPROVAL_LOG;
const scopes = process.env.FIXTURE_SCOPES?.split(" ");

/** Records when each dialog would open and close, so a test can see whether two were ever open at once. */
const approve = async (request) => {
  if (log) appendFileSync(log, `${JSON.stringify({ event: "open", action: request.action, at: Date.now() })}\n`);
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  if (log) appendFileSync(log, `${JSON.stringify({ event: "close", action: request.action, at: Date.now() })}\n`);
  return answer;
};

const refuse = () => Promise.reject(new Error("not available in the fixture"));
const auth = { accessToken: refuse, login: refuse, logout: refuse, status: async () => ({ logged_in: true, storage: "fixture", ...(scopes ? { scopes } : {}) }) };

await serveMcp({ client: createHttpClient(refuse), approve, auth });
