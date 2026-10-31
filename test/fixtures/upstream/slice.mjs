import { twice } from './helper.mjs';
export default function execute(input) { return { result: twice(input.value), internal: 'vendor-only' }; }
