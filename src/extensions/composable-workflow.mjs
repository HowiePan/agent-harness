import { defineExtensionPack } from './contract.mjs';
import { composableWorkflowProfile } from '../profiles/composable-workflow.mjs';

export const extensionPack = defineExtensionPack({ id: 'composable-workflow-profile', version: '1.0.0', profiles: [composableWorkflowProfile] });
export default extensionPack;
