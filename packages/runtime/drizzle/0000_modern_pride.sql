CREATE TABLE "repository_leases" (
	"repository" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"generation" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_leases_task_id_unique" UNIQUE("task_id")
);
--> statement-breakpoint
CREATE TABLE "task_runs" (
	"task_id" text PRIMARY KEY NOT NULL,
	"contract_hash" text NOT NULL,
	"contract" jsonb NOT NULL,
	"repository" text NOT NULL,
	"state" text NOT NULL,
	"writer_generation" integer NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
