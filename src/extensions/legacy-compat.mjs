import { CardWorldLegacyImporter } from '../recovery/cardworld-importer.mjs';
import { CollectionLegacyImporter } from '../recovery/collection-importer.mjs';
import { defineExtensionPack } from './contract.mjs';

export const extensionPack = defineExtensionPack({
  id: 'legacy-compatibility',
  version: '1.0.0',
  recoveryImporters: [new CardWorldLegacyImporter(), new CollectionLegacyImporter()],
});

export default extensionPack;

