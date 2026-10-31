#!/usr/bin/env node
import { main } from '../src/cli.mjs';
try { await main(); }
catch (error) { console.error(`bolt-mcp: ${error.message}`); process.exitCode = 1; }
