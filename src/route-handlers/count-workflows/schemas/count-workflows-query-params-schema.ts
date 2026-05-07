import { visibilityQuerySchema } from '@/route-handlers/list-workflows/schemas/list-workflows-query-params-schema';
import validateArchivedQueryParams from '@/utils/visibility/validate-archived-query-params';

const countWorkflowsQueryParamSchema = visibilityQuerySchema.superRefine(
  validateArchivedQueryParams
);

export default countWorkflowsQueryParamSchema;
