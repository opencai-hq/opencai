const { z } = require('zod');
const { CHAT_MODES } = require('../../constants/chatModes');
const { DASHBOARD_PERIODS, MAX_TEMPLATE_CHARS } = require('../../constants/dashboard');
const { chartSpecSchema } = require('../../ai/dashboard/chartSpec');
const { chartHtmlSchema } = require('../../ai/dashboard/chartHtml');
const { stepsSchema } = require('../../ai/dashboard/chain');

const mode = z.enum(Object.values(CHAT_MODES));
const period = z.enum(Object.values(DASHBOARD_PERIODS));
const title = z.string().trim().min(1).max(80);
const query = z.string().trim().min(1).max(500);

const listWidgetsSchema = z.object({
  workspaceId: z.string().min(1),
  mode,
});

const previewWidgetSchema = z.object({
  workspaceId: z.string().min(1),
  mode,
  query,
});

// A graph runs `steps` when it has them; its commandTemplate is then taken
// from the first step.
const createWidgetSchema = z
  .object({
    workspaceId: z.string().min(1),
    mode,
    query,
    title,
    commandTemplate: z.string().trim().min(1).max(MAX_TEMPLATE_CHARS).optional(),
    steps: stepsSchema.optional(),
    period,
    chartSpec: chartSpecSchema,
    chartHtml: chartHtmlSchema,
  })
  .refine((body) => body.commandTemplate || body.steps, {
    message: 'A command or steps are required',
  });

const updateWidgetSchema = z
  .object({
    title: title.optional(),
    period: period.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Nothing to update',
  });

module.exports = {
  listWidgetsSchema,
  previewWidgetSchema,
  createWidgetSchema,
  updateWidgetSchema,
};
