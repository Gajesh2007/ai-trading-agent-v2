import { tool } from 'ai';
import { z } from 'zod';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const execFileAsync = promisify(execFile);

export const simulationTools = {
  runSimulation: tool({
    description: `Run Python code in a sandboxed environment.
      Available libraries: numpy, pandas, scipy, statistics (standard lib).
      Use for:
      - Monte Carlo simulation of position outcomes
      - Kelly criterion position sizing given prediction market odds
      - Expected value calculations under different scenarios
      - Statistical analysis of funding rate patterns
      - Correlation analysis between prediction market moves and asset moves
      Returns stdout and stderr. Max execution time: 30 seconds.
      NOTE: Filesystem access is restricted. You cannot read or write files.`,
    inputSchema: z.object({
      code: z.string().describe('Python code to execute'),
      description: z.string().describe('What this simulation does and why'),
    }),
    execute: async ({ code, description }) => {
      // Reject code that tries to access the filesystem
      const forbidden = ['open(', 'import os', 'import sys', 'import subprocess',
        'import shutil', '__import__', 'eval(', 'exec(', 'pathlib', 'glob'];
      for (const pattern of forbidden) {
        if (code.includes(pattern)) {
          return { error: `Forbidden: "${pattern}" is not allowed in simulations`, description };
        }
      }

      try {
        // Run in a temp dir so cwd isn't the project root
        const tempDir = mkdtempSync(join(tmpdir(), 'sim-'));
        const { stdout, stderr } = await execFileAsync(
          'python3', ['-c', code],
          { timeout: 30000, maxBuffer: 1024 * 1024, cwd: tempDir },
        );
        return { stdout, stderr, description };
      } catch (e: any) {
        return {
          error: e.message,
          stderr: e.stderr ?? '',
          stdout: e.stdout ?? '',
          description,
        };
      }
    },
  }),
};
