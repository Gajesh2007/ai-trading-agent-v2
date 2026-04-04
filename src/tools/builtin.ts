import { tool } from 'ai';
import { z } from 'zod';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve, relative } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const WORKSPACE_ROOT = resolve(process.cwd(), 'workspace');
const LOGS_ROOT = resolve(process.cwd(), 'logs');

function isAllowedPath(filepath: string): boolean {
  const resolved = resolve(filepath);
  return resolved.startsWith(WORKSPACE_ROOT) || resolved.startsWith(LOGS_ROOT);
}

export const builtinTools = {
  readFile: tool({
    description: `Read the contents of a file from workspace/ or logs/. Use this to:
      - Read previous theses from workspace/state/thesis-registry.json
      - Read signal cache outputs from workspace/state/signal-cache/*.json
      - Read decision logs from workspace/state/decisions-log.jsonl
      - Read cycle summaries from workspace/state/cycle-summaries.jsonl
      - Read paper equity from workspace/state/paper-equity.json
      - Read progress log from workspace/progress.md
      - Read LLM detail logs from logs/llm-detail-*.jsonl
      - Read event logs from logs/discovery-*.jsonl
      Cannot read files outside workspace/ and logs/.`,
    inputSchema: z.object({
      path: z.string().describe('Relative path from project root, e.g. "workspace/state/thesis-registry.json" or "logs/discovery-2026-04-04.jsonl"'),
      maxLines: z.number().optional().describe('Max lines to return (default 200). Use for large JSONL files.'),
    }),
    execute: async ({ path, maxLines }) => {
      const fullPath = resolve(process.cwd(), path);
      if (!isAllowedPath(fullPath)) {
        return { error: `Access denied. Can only read files in workspace/ and logs/` };
      }
      try {
        const content = readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');
        const limit = maxLines ?? 200;
        if (lines.length > limit) {
          return {
            content: lines.slice(-limit).join('\n'),
            totalLines: lines.length,
            truncated: true,
            note: `Showing last ${limit} of ${lines.length} lines. Use maxLines to adjust.`,
          };
        }
        return { content, totalLines: lines.length };
      } catch (e: any) {
        return { error: e.message };
      }
    },
  }),

  listFiles: tool({
    description: `List files in a workspace/ or logs/ directory. Use to discover what state files, signal caches, and logs are available.`,
    inputSchema: z.object({
      path: z.string().optional().describe('Relative path, e.g. "workspace/state" or "logs". Default: "workspace"'),
    }),
    execute: async ({ path }) => {
      const dir = resolve(process.cwd(), path ?? 'workspace');
      if (!isAllowedPath(dir)) {
        return { error: 'Access denied. Can only list workspace/ and logs/' };
      }
      try {
        const entries = readdirSync(dir).map(name => {
          const full = join(dir, name);
          const stat = statSync(full);
          return {
            name,
            type: stat.isDirectory() ? 'dir' : 'file',
            size: stat.size,
            modified: stat.mtime.toISOString(),
          };
        });
        return { path: relative(process.cwd(), dir), entries };
      } catch (e: any) {
        return { error: e.message };
      }
    },
  }),

  grepFiles: tool({
    description: `Search for a pattern across workspace/ and logs/ files. Uses ripgrep (rg) syntax.
      Examples:
      - Search for a ticker: pattern="NVDA" path="workspace/state"
      - Search decision logs: pattern="REJECT" path="workspace/state/decisions-log.jsonl"
      - Search all logs: pattern="circuit_breaker" path="logs"
      - Find high-conviction theses: pattern="conviction.*[89]" path="workspace/state"`,
    inputSchema: z.object({
      pattern: z.string().describe('Regex pattern to search for'),
      path: z.string().optional().describe('Directory or file to search, relative to project root. Default: "workspace"'),
      maxResults: z.number().optional().describe('Max matching lines (default 50)'),
    }),
    execute: async ({ pattern, path, maxResults }) => {
      const searchPath = resolve(process.cwd(), path ?? 'workspace');
      if (!isAllowedPath(searchPath)) {
        return { error: 'Access denied. Can only search workspace/ and logs/' };
      }
      try {
        const { stdout } = await execFileAsync(
          'grep', ['-rn', '--include=*.json', '--include=*.jsonl', '--include=*.md', '-E', pattern, searchPath],
          { timeout: 10000, maxBuffer: 512 * 1024 },
        );
        const lines = stdout.trim().split('\n').filter(Boolean);
        const limit = maxResults ?? 50;
        return {
          matches: lines.slice(0, limit).map(line => {
            // Strip absolute path prefix for readability
            return line.replace(process.cwd() + '/', '');
          }),
          totalMatches: lines.length,
          truncated: lines.length > limit,
        };
      } catch (e: any) {
        if (e.code === 1) return { matches: [], totalMatches: 0 }; // grep returns 1 for no matches
        return { error: e.message };
      }
    },
  }),

  bash: tool({
    description: `Run a read-only shell command. Use for:
      - curl to fetch data from APIs not covered by other tools
      - jq to query JSONL log files (e.g. "cat logs/discovery-*.jsonl | jq '.candidates | length'")
      - python3 for quick calculations
      - date, cal for time-related checks
      RESTRICTIONS: No write operations (rm, mv, cp, tee, >, >>), no package installs, no git operations.
      Max 30 second timeout.`,
    inputSchema: z.object({
      command: z.string().describe('Shell command to execute'),
      description: z.string().describe('What this command does'),
    }),
    execute: async ({ command, description }) => {
      // Block destructive commands
      const forbidden = [
        'rm ', 'rm\t', 'rmdir', 'mv ', 'cp ', '> ', '>> ', 'tee ',
        'chmod', 'chown', 'kill', 'pkill', 'mkfs', 'dd ',
        'npm ', 'yarn ', 'pnpm ', 'pip ', 'brew ',
        'git push', 'git reset', 'git checkout', 'git clean',
        'curl.*-X POST', 'curl.*-X PUT', 'curl.*-X DELETE', 'curl.*-d ',
      ];
      for (const pattern of forbidden) {
        if (new RegExp(pattern).test(command)) {
          return { error: `Blocked: "${pattern}" is not allowed. This tool is read-only.`, description };
        }
      }

      try {
        const { stdout, stderr } = await execFileAsync(
          'bash', ['-c', command],
          { timeout: 30000, maxBuffer: 1024 * 1024, cwd: process.cwd() },
        );
        return { stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 2000), description };
      } catch (e: any) {
        return { error: e.message, stderr: e.stderr?.slice(0, 2000) ?? '', description };
      }
    },
  }),
};
