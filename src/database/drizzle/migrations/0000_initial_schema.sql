CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"executor_url" text NOT NULL,
	"callback_token" text,
	"webhook_url" text,
	"cancel_url" text,
	"result" jsonb,
	"error" jsonb,
	"progress" integer DEFAULT 0 NOT NULL,
	"timeout_seconds" integer DEFAULT 300 NOT NULL,
	"processing_started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_status_check" CHECK ("tasks"."status" IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED')),
	CONSTRAINT "tasks_valid_state_data" CHECK (
        ("tasks"."status" = 'PENDING'
          AND "tasks"."processing_started_at" IS NULL
          AND "tasks"."completed_at" IS NULL)
        OR
        ("tasks"."status" = 'PROCESSING'
          AND "tasks"."processing_started_at" IS NOT NULL
          AND "tasks"."completed_at" IS NULL)
        OR
        ("tasks"."status" IN ('COMPLETED', 'FAILED')
          AND "tasks"."processing_started_at" IS NOT NULL
          AND "tasks"."completed_at" IS NOT NULL)
        OR
        ("tasks"."status" = 'CANCELLED'
          AND "tasks"."completed_at" IS NOT NULL)
      )
);
--> statement-breakpoint
CREATE TABLE "task_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_events_type_check" CHECK ("task_events"."event_type" IN ('progress', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tasks_processing_started_at_idx" ON "tasks" USING btree ("processing_started_at");--> statement-breakpoint
CREATE INDEX "tasks_completed_at_idx" ON "tasks" USING btree ("completed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_idempotency_key_idx" ON "tasks" USING btree ("idempotency_key") WHERE "tasks"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "task_events_task_id_seq_unique_idx" ON "task_events" USING btree ("task_id","seq");--> statement-breakpoint
CREATE INDEX "task_events_created_at_idx" ON "task_events" USING btree ("created_at");