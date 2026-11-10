import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const courseEventSchema = z.discriminatedUnion("type", [
  z.object({
    event_id: z.string().min(1),
    type: z.literal("course.published"),
    course_id: z.string().min(1),
    occurred_at: z.string().datetime(),
  }),
  z.object({
    event_id: z.string().min(1),
    type: z.literal("learner.deadline_changed"),
    course_id: z.string().min(1),
    learner_id: z.string().min(1),
    deadline_at: z.string().datetime(),
    occurred_at: z.string().datetime(),
  }),
  z.object({
    event_id: z.string().min(1),
    type: z.literal("educator.report_ready"),
    course_id: z.string().min(1),
    report_id: z.string().min(1),
    occurred_at: z.string().datetime(),
  }),
]);

export type CourseEvent = z.infer<typeof courseEventSchema>;

export type ReplayDecision =
  | { action: "publish_course"; course_id: string; event_id: string }
  | { action: "reschedule_deadline"; course_id: string; learner_id: string; deadline_at: string; event_id: string }
  | { action: "release_report"; course_id: string; report_id: string; event_id: string };

export function decideReplay(input: unknown, seen: ReadonlySet<string>): ReplayDecision | null {
  const event = courseEventSchema.parse(input);
  if (seen.has(event.event_id)) return null;

  switch (event.type) {
    case "course.published":
      return { action: "publish_course", course_id: event.course_id, event_id: event.event_id };
    case "learner.deadline_changed":
      return {
        action: "reschedule_deadline",
        course_id: event.course_id,
        learner_id: event.learner_id,
        deadline_at: event.deadline_at,
        event_id: event.event_id,
      };
    case "educator.report_ready":
      return { action: "release_report", course_id: event.course_id, report_id: event.report_id, event_id: event.event_id };
  }
}

export function verifyWebhookSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  const supplied = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(supplied, "hex"));
}
