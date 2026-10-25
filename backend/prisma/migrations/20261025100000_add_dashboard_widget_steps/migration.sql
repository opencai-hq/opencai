-- The chain of commands behind a graph. Null for a one-command graph.
ALTER TABLE "dashboard_widgets" ADD COLUMN "steps" JSONB;
