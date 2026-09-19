import { defineWorkflowDefinition } from '../../../../src/platform/workflow/definition.mjs';
import { briefNodes } from '../nodes/brief/index.mjs';

export const workflow = defineWorkflowDefinition({
  id: 'source-brief', version: '1.0.0', profileId: 'composable-workflow',
  routes: { summarize: briefNodes },
});
