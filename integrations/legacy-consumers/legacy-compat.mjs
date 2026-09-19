import { CardWorldLegacyImporter } from './cardworld/importer.mjs';
import { CollectionLegacyImporter } from './collection/importer.mjs';
import { defineExtensionPack } from '../../src/platform/extensions/contract.mjs';

export const extensionPack = defineExtensionPack({
  id: 'legacy-compatibility',
  version: '1.0.0',
  recoveryImporters: [new CardWorldLegacyImporter(), new CollectionLegacyImporter()],
});

export default extensionPack;
