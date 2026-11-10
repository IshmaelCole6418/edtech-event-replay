import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { decideReplay, verifyWebhookSignature } from "../src/course_event_policy.js";

test("a signed learner deadline change produces one reschedule decision", () => {
  const event = {
    event_id: "evt-deadline-204",
    type: "learner.deadline_changed",
    course_id: "course-pharmacology-4",
    learner_id: "learner-81",
    deadline_at: "2026-10-08T17:00:00.000Z",
    occurred_at: "2026-10-01T09:15:00.000Z",
  } as const;
  const raw = Buffer.from(JSON.stringify(event));
  const secret = "local-test-secret-with-thirty-two-characters";
  const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

  assert.equal(verifyWebhookSignature(raw, signature, secret), true);
  assert.deepEqual(decideReplay(event, new Set()), {
    action: "reschedule_deadline",
    course_id: "course-pharmacology-4",
    learner_id: "learner-81",
    deadline_at: "2026-10-08T17:00:00.000Z",
    event_id: "evt-deadline-204",
  });
  assert.equal(decideReplay(event, new Set([event.event_id])), null);
});
