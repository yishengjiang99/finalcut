#!/usr/bin/env node
// Regenerates docs/api/tools-schema.v<version>.json from src/tools.js.
import { writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildToolsSchema, TOOLS_SCHEMA_VERSION } from '../src/server/toolsSchema.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs', 'api', `tools-schema.v${TOOLS_SCHEMA_VERSION}.json`);
writeFileSync(out, `${JSON.stringify(buildToolsSchema(), null, 2)}\n`);
console.log(`Wrote ${path.relative(root, out)}`);
