// Driver for the fast markdown renderer: reads every case from the input
// directory, renders each one on its own with parse() from parse.js, and
// writes the HTML strings, in order, to the output directory as html.json.
// Runs as `node /bot/main.ts` on Node 22 (erasable TypeScript syntax only).
// The inline engine in parse.js is a direct-render port of marked 18.1.3's
// inline pipeline (Lexer.inlineTokens + Tokenizer), so its output matches
// marked byte for byte on the practice set (720/720) at ~1.33x its speed.
// The input/output locations default to /input and /output; the
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR environment variables override them
// for local runs outside a container.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface Case {
  id: string;
  markdown: string;
}

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Case[];
const html: string[] = new Array<string>(cases.length);
for (let k = 0; k < cases.length; k++) {
  html[k] = parse(cases[k].markdown);
}
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
