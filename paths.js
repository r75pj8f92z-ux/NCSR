// Locates project files in local runs and in the Vercel bundle. This file sits in the project root.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const paths = { root: here };
export const dataFile = (name) => path.join(here, 'data', name);
