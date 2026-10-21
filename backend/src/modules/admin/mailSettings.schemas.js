const { z } = require('zod');

const MAIL_SECURITY = ['NONE', 'STARTTLS', 'TLS'];

// Fields required before mail can be switched on -- without them no reset
// link could be sent or built.
const REQUIRED_WHEN_ENABLED = ['host', 'port', 'fromAddress', 'publicAppUrl'];

const updateMailSettingsSchema = z
  .object({
    enabled: z.boolean(),
    host: z.string().trim().min(1).max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    security: z.enum(MAIL_SECURITY),
    username: z.string().trim().max(255).optional(),
    password: z.string().min(1).optional(), // write-only; omit to leave the stored one unchanged
    fromAddress: z.string().trim().email().optional(),
    fromName: z.string().trim().max(100).optional(),
    publicAppUrl: z
      .string()
      .trim()
      .url()
      .refine((url) => /^https?:\/\//.test(url), 'Must start with http:// or https://')
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.enabled) return;
    for (const field of REQUIRED_WHEN_ENABLED) {
      if (data[field] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: 'Required to turn email on.',
        });
      }
    }
  });

const sendTestEmailSchema = z.object({
  to: z.string().trim().email(),
});

module.exports = { updateMailSettingsSchema, sendTestEmailSchema };
