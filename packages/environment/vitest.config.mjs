import { fileURLToPath } from 'node:url';
export default {
 resolve: { alias: { e2b: fileURLToPath(new URL('./dist/sdk.js', import.meta.url)) } },
 test: { include: ['test/sandbox/*.test.ts'], testTimeout: 15000 }
};
