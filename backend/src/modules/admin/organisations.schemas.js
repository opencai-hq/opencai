const { z } = require('zod');
const { CSP } = require('../../constants/csp');

const createOrganisationSchema = z.object({
  name: z.string().min(1).max(200),
  address: z.string().max(500).optional(),
  phone: z.string().max(50).optional(),
});

const updateOrganisationSchema = createOrganisationSchema.partial();

const createWorkspaceSchema = z.object({
  csp: z.enum(Object.values(CSP)),
  account: z.string().min(1).max(200),
  environment: z.string().min(1).max(100),
});

const updateWorkspaceSchema = z.object({
  account: z.string().min(1).max(200).optional(),
  environment: z.string().min(1).max(100).optional(),
  isActive: z.boolean().optional(),
});

module.exports = {
  createOrganisationSchema,
  updateOrganisationSchema,
  createWorkspaceSchema,
  updateWorkspaceSchema,
};
