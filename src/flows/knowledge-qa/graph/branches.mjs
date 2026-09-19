import { qaPorts } from '../contracts/index.mjs';

export const createAnswerBranches = ({ answer, search, clarify }) => [
  { nodeId: 'lookup', portId: 'match', schemaId: qaPorts.match, path: 'hit', equals: true, features: answer },
  { nodeId: 'lookup', portId: 'match', schemaId: qaPorts.match, path: 'hit', equals: false, features: search },
  { nodeId: 'search', portId: 'candidate', schemaId: qaPorts.candidate, path: 'ready', equals: true, features: answer },
  { nodeId: 'search', portId: 'candidate', schemaId: qaPorts.candidate, path: 'ready', equals: false, features: clarify },
];
