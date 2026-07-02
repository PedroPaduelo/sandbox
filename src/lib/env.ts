import path from "node:path";
import { z } from "zod";
import { parseSizeBytes, parsePercent } from "./parse-helpers";

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(8080),
  SANDBOX_TOKEN: z.string().min(1),
  WORKSPACE: z.string().default("/workspace"),
  RATE_LIMIT_MAX: z.coerce.number().default(1000),
  SANDBOX_MEMORY_MAX: z.string().default("4G"),
  SANDBOX_MEMORY_HIGH: z.string().default("3G"),
  SANDBOX_CPU_QUOTA: z.string().default("200%"),
  SANDBOX_TASKS_MAX: z.string().default("4096"),
  GIT_CLONE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120000),
  // Timeout do `run_command` (síncrono via MCP / REST). Default 5 min
  // pra suportar `npm install`, `cargo build`, `pip install`, `tsc -b`,
  // etc. Para comandos verdadeiramente longos (build de Docker, dev
  // server contínuo), o agente deve usar `start_process` em background.
  SHELL_RUN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(300_000),
  // Buffer máximo de stdout/stderr capturado pelo `run_command` síncrono.
  // 8 KB / 4 KB era apertado pra outputs de build/test.
  SHELL_STDOUT_MAX_BYTES: z.coerce.number().int().min(1024).default(256 * 1024),
  SHELL_STDERR_MAX_BYTES: z.coerce.number().int().min(1024).default(128 * 1024),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error("❌ Invalid environment variables:\n", _env.error.flatten().fieldErrors);
  throw new Error("Invalid environment variables");
}

const raw = _env.data;

export const env = {
  ...raw,
  workspace: path.resolve(raw.WORKSPACE),
  limits: {
    memoryMaxBytes: parseSizeBytes(raw.SANDBOX_MEMORY_MAX, "4G"),
    memoryHighBytes: parseSizeBytes(raw.SANDBOX_MEMORY_HIGH, "3G"),
    cpuQuotaPercent: parsePercent(raw.SANDBOX_CPU_QUOTA, 200),
    tasksMax: parseInt(raw.SANDBOX_TASKS_MAX, 10),
    memoryMax: raw.SANDBOX_MEMORY_MAX,
    memoryHigh: raw.SANDBOX_MEMORY_HIGH,
    cpuQuota: raw.SANDBOX_CPU_QUOTA,
    tasksMaxStr: raw.SANDBOX_TASKS_MAX,
  },
} as const;

export type Env = typeof env;
