-- The AI-written page that draws a graph. Null on graphs saved before this.
ALTER TABLE "dashboard_widgets" ADD COLUMN "chartHtml" TEXT;
