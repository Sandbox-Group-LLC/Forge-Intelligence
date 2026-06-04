// Regenerate the committed route snapshot. Run after an INTENTIONAL route
// change (add/remove/rename) and commit the diff:  npm run routes:snapshot
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { collectRoutes } from './route-inventory.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const routes = collectRoutes();
writeFileSync(join(__dirname, 'routes.snapshot.json'), JSON.stringify(routes, null, 2) + '\n');
console.log(`route snapshot regenerated (${routes.length} routes)`);
