const { z } = require('zod');
const { emailField } = require('./operators.schemas');

const createAdministratorSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(8),
  email: emailField.optional(),
});

const updateAdministratorSchema = z.object({
  email: emailField.nullable(), // null clears it
});

module.exports = { createAdministratorSchema, updateAdministratorSchema };
