#!/usr/bin/env node
/**
 * publish.mjs — copy the built site (dist/) to the repo root so the repo itself
 * is the publishable static site: index.html + assets/ at the top level.
 * GitHub Pages then needs nothing but "Deploy from a branch".
 */
import { cpSync, rmSync } from 'node:fs';

rmSync('assets', { recursive: true, force: true });
cpSync('dist/assets', 'assets', { recursive: true });
cpSync('dist/index.html', 'index.html');
console.log('✓ repo root is now the static site: index.html + assets/');
