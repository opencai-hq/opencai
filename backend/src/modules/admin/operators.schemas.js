const { z } = require('zod');

// Where password reset links go. Stored lowercased so lookups by email match
// however the address is typed.
const emailField = z.string().trim().toLowerCase().email().max(254);

const createOperatorSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(8),
  organisationIds: z.array(z.string()).optional().default([]),
  email: emailField.optional(),
});

const updateOperatorSchema = z.object({
  organisationIds: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
  email: emailField.nullable().optional(), // null clears it
});

module.exports = { emailField, createOperatorSchema, updateOperatorSchema };
