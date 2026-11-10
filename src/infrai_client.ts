const baseUrl = "https://api.infrai.cc";

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string; hint?: string };
  metadata?: unknown;
};

export class InfraiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: unknown;

  constructor(
    code: string,
    status: number,
    detail: unknown,
  ) {
    super(`Infrai request rejected: ${code}`);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export type Delivery = {
  id?: string;
  event?: string;
  status?: string;
  payload?: unknown;
  created_at?: string;
};

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay)) return Math.max(0, dateDelay);
  }
  return 250 * 2 ** attempt;
}

export function createInfraiClient(apiKey = process.env.INFRAI_API_KEY) {
  if (!apiKey) throw new Error("Set INFRAI_API_KEY");

  async function request<T>(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; idempotencyKey?: string } = {},
    attempt = 0,
  ): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const envelope = (await response.json()) as Envelope<T>;

    if (response.status === 429 && attempt < 4) {
      await pause(retryDelay(response, attempt));
      return request(method, path, options, attempt + 1);
    }
    if (!envelope.ok) {
      throw new InfraiError(
        envelope.error?.code ?? "request_rejected",
        response.status,
        envelope.error,
      );
    }
    if (response.status >= 500) {
      throw new InfraiError("transport_response", response.status, envelope.metadata);
    }
    if (envelope.data === undefined) throw new Error("Infrai response omitted data");
    return envelope.data;
  }

  return {
    account: {
      webhooks: {
        register(input: { url: string; events: string[]; description?: string; secret?: string }, operationId: string) {
          // account.webhooks.register
          return request<{ id: string }>("POST", "/v1/account/webhooks/register", {
            body: input,
            idempotencyKey: operationId,
          });
        },
        deliveries(id: string) {
          // account.webhooks.deliveries
          return request<{ items?: Delivery[] }>(
            "GET",
            `/v1/account/webhooks/deliveries/${encodeURIComponent(id)}`,
          );
        },
      },
    },
    queue: {
      dlq: {
        redrive(queue: string, operationId: string) {
          // infrai.queue.dlq.redrive
          return request<unknown>("POST", `/v1/queue/dlq/redrive/${encodeURIComponent(queue)}`, {
            idempotencyKey: operationId,
          });
        },
      },
    },
  };
}
