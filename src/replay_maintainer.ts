import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { courseEventSchema, decideReplay, verifyWebhookSignature } from "./course_event_policy.js";
import { createInfraiClient, InfraiError } from "./infrai_client.js";

const registerSchema = z.object({
  url: z.string().url(),
  secret: z.string().min(32),
  operation_id: z.string().min(1),
});

const redriveSchema = z.object({
  queue: z.string().min(1),
  operations_per_minute: z.number().int().min(1).max(60),
  cycles: z.number().int().min(1).max(100),
  operation_id: z.string().min(1),
});

function requireArgument(index: number, usage: string): string {
  const value = process.argv[index];
  if (!value) throw new Error(usage);
  return value;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function register(): Promise<void> {
  const input = registerSchema.parse(await readJson(requireArgument(3, "register INPUT_JSON")));
  const client = createInfraiClient();
  const result = await client.account.webhooks.register({
    url: input.url,
    events: ["queue.dlq"],
    description: "Edtech course delivery replay receiver",
    secret: input.secret,
  }, input.operation_id);
  console.log(JSON.stringify({ webhook_id: result.id, state: "registered" }, null, 2));
}

async function inspectDeliveries(): Promise<void> {
  const webhookId = requireArgument(3, "deliveries WEBHOOK_ID");
  const result = await createInfraiClient().account.webhooks.deliveries(webhookId);
  console.log(JSON.stringify({ webhook_id: webhookId, deliveries: result.items ?? [] }, null, 2));
}

async function replaySignedEvent(): Promise<void> {
  const path = requireArgument(3, "apply EVENT_JSON SIGNATURE");
  const signature = requireArgument(4, "apply EVENT_JSON SIGNATURE");
  const secret = process.env.INFRAI_WEBHOOK_SECRET;
  if (!secret) throw new Error("Set INFRAI_WEBHOOK_SECRET");
  const rawBody = await readFile(path);
  if (!verifyWebhookSignature(rawBody, signature, secret)) throw new Error("Signature did not match the raw event body");
  const event = courseEventSchema.parse(JSON.parse(rawBody.toString("utf8")));
  const decision = decideReplay(event, new Set());
  console.log(JSON.stringify({ accepted: true, decision }, null, 2));
}

async function redriveAtRate(): Promise<void> {
  const input = redriveSchema.parse(await readJson(requireArgument(3, "redrive INPUT_JSON")));
  const client = createInfraiClient();
  const interval = 60_000 / input.operations_per_minute;
  for (let cycle = 0; cycle < input.cycles; cycle += 1) {
    await client.queue.dlq.redrive(input.queue, `${input.operation_id}-${cycle + 1}`);
    if (cycle + 1 < input.cycles) await new Promise((resolve) => setTimeout(resolve, interval));
  }
  console.log(JSON.stringify({ queue: input.queue, cycles: input.cycles, state: "redrive_complete" }, null, 2));
}

async function rawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function receive(request: IncomingMessage, response: ServerResponse, secret: string): Promise<void> {
  if (request.method !== "POST" || request.url !== "/course-events") {
    respond(response, 404, { error: "route_not_found" });
    return;
  }
  const body = await rawBody(request);
  const signature = request.headers["x-infrai-signature"];
  if (typeof signature !== "string" || !verifyWebhookSignature(body, signature, secret)) {
    respond(response, 401, { error: "invalid_signature" });
    return;
  }
  const parsed = courseEventSchema.safeParse(JSON.parse(body.toString("utf8")));
  if (!parsed.success) {
    respond(response, 400, { error: "invalid_course_event", issues: parsed.error.issues });
    return;
  }
  respond(response, 202, { accepted: true, decision: decideReplay(parsed.data, new Set()) });
}

async function serve(): Promise<void> {
  const secret = process.env.INFRAI_WEBHOOK_SECRET;
  if (!secret) throw new Error("Set INFRAI_WEBHOOK_SECRET");
  const port = z.coerce.number().int().positive().parse(process.env.PORT ?? 3000);
  const server = createServer((request, response) => {
    receive(request, response, secret).catch(() => respond(response, 400, { error: "invalid_request" }));
  });
  server.listen(port, () => console.log(`course event receiver listening on http://localhost:${port}`));
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "register") return register();
  if (command === "deliveries") return inspectDeliveries();
  if (command === "apply") return replaySignedEvent();
  if (command === "redrive") return redriveAtRate();
  if (command === "serve") return serve();
  throw new Error("Use serve, register, deliveries, apply, or redrive");
}

main().catch((error: unknown) => {
  if (error instanceof z.ZodError) {
    console.error(JSON.stringify({ error: "invalid_request", issues: error.issues }));
    process.exitCode = 2;
    return;
  }
  if (error instanceof InfraiError) {
    console.error(JSON.stringify({ error: error.code, status: error.status }));
    process.exitCode = error.status >= 400 && error.status < 500 ? 2 : 1;
    return;
  }
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
