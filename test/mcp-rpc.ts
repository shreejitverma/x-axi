// A minimal MCP client for tests: raw JSON-RPC, so a test sees every frame the server sends.
import { InMemoryTransport, type JSONRPCMessage, type McpServer } from "@modelcontextprotocol/server";
import { decode } from "@toon-format/toon";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type Frame = { jsonrpc: string; id?: number; method?: string; result?: Record<string, unknown>; error?: { code: number; message: string } };
export type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

abstract class Session {
  private nextId = 1;
  private readonly pending = new Map<number, (frame: Frame) => void>();
  /** Response IDs in the order they arrived. */
  readonly arrivals: number[] = [];

  protected abstract write(message: Record<string, unknown>): void;

  protected receive(frame: Frame): void {
    if (frame.id === undefined || (frame.result === undefined && frame.error === undefined)) return;
    this.arrivals.push(frame.id);
    this.pending.get(frame.id)?.(frame);
    this.pending.delete(frame.id);
  }

  request(method: string, params?: Record<string, unknown>): Promise<Frame> {
    const id = this.nextId++;
    const answer = new Promise<Frame>((resolve) => this.pending.set(id, resolve));
    this.write({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    return answer;
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  /** The ID the next request will get. */
  get upcomingId(): number {
    return this.nextId;
  }

  async initialize(protocolVersion = "2025-11-25"): Promise<Frame> {
    const frame = await this.request("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "x-axi-test", version: "0" } });
    this.notify("notifications/initialized");
    return frame;
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const frame = await this.request("tools/call", { name, arguments: args });
    if (frame.error) throw new Error(`protocol error ${frame.error.code}: ${frame.error.message}`);
    return frame.result as unknown as ToolResult;
  }

  async tools(): Promise<{ name: string; title?: string; description: string; inputSchema: Record<string, unknown>; annotations: Record<string, boolean> }[]> {
    const frame = await this.request("tools/list");
    return (frame.result as { tools: never[] }).tools;
  }
}

/** Runs a node entry point with the given argv as an MCP server over stdio. */
export class StdioSession extends Session {
  readonly child: ChildProcessWithoutNullStreams;
  /** Every line the server wrote to stdout, unparsed. */
  readonly lines: string[] = [];
  stderr = "";
  private readonly exited: Promise<number | null>;

  constructor(argv: string[], env: NodeJS.ProcessEnv) {
    super();
    this.child = spawn(process.execPath, argv, { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.setEncoding("utf8").on("data", (chunk: string) => (this.stderr += chunk));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      this.lines.push(line);
      try {
        this.receive(JSON.parse(line) as Frame);
      } catch {
        // Kept in `lines`, where the test reports it.
      }
    });
    this.exited = new Promise((resolve) => this.child.once("exit", resolve));
  }

  protected write(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** Closes stdin, as a client does, and waits for the server to exit. */
  async close(): Promise<number | null> {
    this.child.stdin.end();
    return this.exited;
  }
}

/** Connects to a server in this process. */
export class MemorySession extends Session {
  private readonly client: InMemoryTransport;

  private constructor(client: InMemoryTransport) {
    super();
    this.client = client;
    client.onmessage = (message: JSONRPCMessage) => this.receive(message as Frame);
  }

  static async connect(server: McpServer): Promise<MemorySession> {
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    const session = new MemorySession(client);
    await server.connect(serverSide);
    await client.start();
    return session;
  }

  protected write(message: Record<string, unknown>): void {
    void this.client.send(message as JSONRPCMessage);
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

export function textOf(result: ToolResult): string {
  return result.content.map((block) => block.text).join("\n");
}

/** The TOON text of a result, decoded. */
export function decoded(result: ToolResult): Record<string, unknown> {
  return decode(textOf(result)) as Record<string, unknown>;
}
