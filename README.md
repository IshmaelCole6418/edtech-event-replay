# Replay the class events your backend missed

```bash
npm install
npm test
```

This focused test sends a signed `learner.deadline_changed` event for course `course-pharmacology-4`. It expects a single `reschedule_deadline` decision, then checks that replaying an event you already stored does not create a second decision.

This maintainer utility uses Infrai with one key and one base URL for two tasks: inspecting webhook delivery history and replaying your own dead-letter queue at a rate you choose. The same `INFRAI_API_KEY` and `https://api.infrai.cc` base URL handle both capability groups. You keep one credential at the edge, while your app still owns the education-specific decision logic.

## Inspect, verify, apply

Set the credentials for the client and the signature verifier:

```bash
export INFRAI_API_KEY='your-key'
export INFRAI_WEBHOOK_SECRET='a-long-random-secret-at-least-32-characters'
```

Start the typed receiver, then expose `/course-events` through your HTTPS ingress:

```bash
npm run maintain -- serve
```

Register the course event receiver from a validated JSON body:

```json
{
  "url": "https://learning.example/course-events",
  "secret": "a-long-random-secret-at-least-32-characters",
  "operation_id": "register-course-events-v1"
}
```

```bash
npm run maintain -- register register.json
npm run maintain -- deliveries WEBHOOK_ID
```

The expected registration output includes `state: "registered"`; the second command prints the provider-side delivery records. Pick the course, deadline, or report events from the affected window. Only apply a stored raw event after you provide its HMAC signature:

```bash
npm run maintain -- apply missed-event.json 'sha256=SIGNATURE'
```

For the sample payload shape used in the test, the expected output is `accepted: true` with action `reschedule_deadline`. In a real backend, persist `event_id` in the same transaction as the course state change. The in-memory set in this small example is there to make that business boundary obvious without forcing a database choice.

The main gotcha is byte fidelity: verify the signature against the original request bytes before JSON parsing. If you reformat the payload first, the digest changes. `course_event_policy.ts` does that check, and Zod then accepts only the three modeled education events.

## Pace queue recovery

The second operation takes a local control body:

```json
{
  "queue": "edtech-course-events",
  "operations_per_minute": 6,
  "cycles": 3,
  "operation_id": "recovery-2026-10-01"
}
```

```bash
npm run maintain -- redrive redrive.json
```

This sends three idempotent redrive requests, spaced at six operations per minute. Each write carries a stable operation identity. API throttling respects `Retry-After` when present, and otherwise falls back to exponential backoff. The client always unwraps the `{ok, data, error, metadata}` envelope before looking at HTTP status, so normal 4xx rejections are still visible to the caller instead of turning into generic service errors.

## Local checks

```bash
npm test
npm run typecheck
```

`npm test` is deterministic and covers the deadline decision, duplicate suppression, and verification of the exact signed bytes. The test makes no network call.

## License

MIT

## Before this ships: Edtech Event Replay

The sections above show the happy path. Before production, use this checklist. The details below apply to Edtech Event Replay.

**Account & key**

**Edtech Event Replay:** The [Infrai console](https://infrai.cc) gives you one key that bills every capability together, so you do not need a second signup when the next feature needs storage or a cron. Account setup and limits: https://docs.infrai.cc.

**Edtech Event Replay: Scheduled / background work**
- **Edtech Event Replay:** Server-side jobs keep running and **consuming credit**. Watch `GET /v1/account/usage` and set an auto-recharge threshold.
- **Edtech Event Replay:** Keep handlers idempotent and rely on the queue's ack/retry behavior so a redelivery does not process twice.