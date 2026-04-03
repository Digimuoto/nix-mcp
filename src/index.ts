#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import { z } from "zod";

// In-memory log storage (you have 128GB RAM!)
interface LogEntry {
  id: string;
  command: string;
  timestamp: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

const logStore: Map<string, LogEntry> = new Map();
const MAX_LOGS = 100; // Keep last 100 logs

// Tool definitions
const tools: z.infer<typeof ToolSchema>[] = [
  // Build commands
  {
    name: "build",
    description:
      "Build a derivation or fetch a store path. This is the primary command for building packages with Nix. Use this instead of make, cargo build, npm build, etc.",
    inputSchema: {
      type: "object" as const,
      properties: {
        installable: {
          type: "string",
          description:
            "The flake reference or path to build (e.g., '.', '.#package', 'nixpkgs#hello'). Defaults to current directory.",
        },
        out_link: {
          type: "string",
          description:
            "Path for the result symlink. Use empty string to disable.",
        },
        rebuild: {
          type: "boolean",
          description: "Rebuild even if already built (--rebuild flag)",
        },
        working_directory: {
          type: "string",
          description: "Directory to run the command in",
        },
      },
    },
  },
  {
    name: "develop",
    description:
      "Enter or get information about a development shell that provides the build environment of a derivation. Use this instead of manual environment setup.",
    inputSchema: {
      type: "object" as const,
      properties: {
        installable: {
          type: "string",
          description: "The flake reference (e.g., '.', '.#devShell')",
        },
        command: {
          type: "string",
          description:
            "Command to run in the development shell (uses -c flag)",
        },
        working_directory: {
          type: "string",
          description: "Directory to run the command in",
        },
      },
    },
  },
  {
    name: "run",
    description:
      "Run a Nix application directly without installing it. Great for trying out packages.",
    inputSchema: {
      type: "object" as const,
      properties: {
        installable: {
          type: "string",
          description:
            "The flake reference to run (e.g., 'nixpkgs#hello', '.#myapp')",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Arguments to pass to the application",
        },
        working_directory: {
          type: "string",
          description: "Directory to run the command in",
        },
      },
      required: ["installable"],
    },
  },
  {
    name: "search",
    description:
      "Search for packages in nixpkgs or flakes. Use this to find available packages.",
    inputSchema: {
      type: "object" as const,
      properties: {
        installable: {
          type: "string",
          description:
            "The flake to search (defaults to 'nixpkgs'). Can also be a path like '.'",
        },
        regex: {
          type: "string",
          description: "Search term or regex pattern",
        },
        json: {
          type: "boolean",
          description: "Output in JSON format for easier parsing",
        },
      },
      required: ["regex"],
    },
  },
  // Flake commands
  {
    name: "flake_init",
    description:
      "Initialize a new flake in the current directory from a template. Use this to start new Nix projects.",
    inputSchema: {
      type: "object" as const,
      properties: {
        template: {
          type: "string",
          description:
            "Template to use (e.g., 'templates#rust', 'github:nix-community/templates#rust')",
        },
        working_directory: {
          type: "string",
          description: "Directory to initialize the flake in",
        },
      },
    },
  },
  {
    name: "flake_new",
    description: "Create a new flake in a new directory from a template.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path for the new flake directory",
        },
        template: {
          type: "string",
          description: "Template to use",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "flake_show",
    description:
      "Show the outputs of a flake. Useful for understanding what a flake provides.",
    inputSchema: {
      type: "object" as const,
      properties: {
        flake_ref: {
          type: "string",
          description:
            "Flake reference (defaults to current directory). Can be '.', 'nixpkgs', 'github:owner/repo'",
        },
        json: {
          type: "boolean",
          description: "Output in JSON format",
        },
        working_directory: {
          type: "string",
          description: "Directory to run the command in",
        },
      },
    },
  },
  {
    name: "flake_metadata",
    description:
      "Show metadata about a flake including inputs, revision, and last modified time.",
    inputSchema: {
      type: "object" as const,
      properties: {
        flake_ref: {
          type: "string",
          description: "Flake reference (defaults to current directory)",
        },
        json: {
          type: "boolean",
          description: "Output in JSON format",
        },
        working_directory: {
          type: "string",
          description: "Directory to run the command in",
        },
      },
    },
  },
  {
    name: "flake_update",
    description: "Update flake lock file inputs to their latest versions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        inputs: {
          type: "array",
          items: { type: "string" },
          description:
            "Specific inputs to update (updates all if not specified)",
        },
        working_directory: {
          type: "string",
          description: "Directory containing the flake",
        },
      },
    },
  },
  {
    name: "flake_check",
    description:
      "Check a flake for issues. Validates the flake outputs and runs checks defined in the flake.",
    inputSchema: {
      type: "object" as const,
      properties: {
        flake_ref: {
          type: "string",
          description: "Flake reference (defaults to current directory)",
        },
        working_directory: {
          type: "string",
          description: "Directory to run the command in",
        },
      },
    },
  },
  {
    name: "flake_lock",
    description:
      "Create or update a flake lock file without building. Only adds missing inputs; use flake_update to update existing inputs.",
    inputSchema: {
      type: "object" as const,
      properties: {
        flake_ref: {
          type: "string",
          description: "Flake reference (defaults to current directory)",
        },
        working_directory: {
          type: "string",
          description: "Directory to run the command in",
        },
      },
    },
  },
  // Evaluation commands
  {
    name: "eval",
    description:
      "Evaluate a Nix expression and print the result. Useful for inspecting values and debugging.",
    inputSchema: {
      type: "object" as const,
      properties: {
        installable: {
          type: "string",
          description:
            "Installable to evaluate (e.g., '.#packages.x86_64-linux.default.meta')",
        },
        expr: {
          type: "string",
          description: "Nix expression to evaluate (--expr flag)",
        },
        json: {
          type: "boolean",
          description: "Output as JSON",
        },
        raw: {
          type: "boolean",
          description: "Output raw strings without quoting",
        },
        working_directory: {
          type: "string",
          description: "Directory to run the command in",
        },
      },
    },
  },
  // Profile commands
  {
    name: "profile_list",
    description: "List packages installed in the current profile.",
    inputSchema: {
      type: "object" as const,
      properties: {
        profile: {
          type: "string",
          description: "Profile path (defaults to user profile)",
        },
        json: {
          type: "boolean",
          description: "Output in JSON format",
        },
      },
    },
  },
  {
    name: "profile_install",
    description:
      "Install packages into a profile (alias: profile_add). Use this for persistent installations.",
    inputSchema: {
      type: "object" as const,
      properties: {
        installables: {
          type: "array",
          items: { type: "string" },
          description: "Packages to install (e.g., ['nixpkgs#hello'])",
        },
        profile: {
          type: "string",
          description: "Profile path (defaults to user profile)",
        },
      },
      required: ["installables"],
    },
  },
  {
    name: "profile_remove",
    description: "Remove packages from a profile.",
    inputSchema: {
      type: "object" as const,
      properties: {
        packages: {
          type: "array",
          items: { type: "string" },
          description: "Package names or indices to remove",
        },
        profile: {
          type: "string",
          description: "Profile path",
        },
      },
      required: ["packages"],
    },
  },
  {
    name: "profile_upgrade",
    description: "Upgrade packages in a profile to their latest versions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        packages: {
          type: "array",
          items: { type: "string" },
          description: "Package names or indices to upgrade (or '.*' for all)",
        },
        profile: {
          type: "string",
          description: "Profile path",
        },
      },
      required: ["packages"],
    },
  },
  // Store commands
  {
    name: "store_gc",
    description:
      "Run garbage collection on the Nix store to free up disk space.",
    inputSchema: {
      type: "object" as const,
      properties: {
        dry_run: {
          type: "boolean",
          description: "Show what would be deleted without actually deleting",
        },
      },
    },
  },
  {
    name: "store_path_info",
    description: "Query information about store paths.",
    inputSchema: {
      type: "object" as const,
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Store paths to query",
        },
        json: {
          type: "boolean",
          description: "Output in JSON format",
        },
        closure_size: {
          type: "boolean",
          description: "Print closure size",
        },
      },
      required: ["paths"],
    },
  },
  // Utility commands
  {
    name: "fmt",
    description: "Format Nix files using the formatter specified in the flake.",
    inputSchema: {
      type: "object" as const,
      properties: {
        working_directory: {
          type: "string",
          description: "Directory to run the formatter in",
        },
      },
    },
  },
  {
    name: "log",
    description: "Show the build log for a derivation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        installable: {
          type: "string",
          description: "The installable to show logs for",
        },
        working_directory: {
          type: "string",
          description: "Directory to run the command in",
        },
      },
      required: ["installable"],
    },
  },
  {
    name: "why_depends",
    description:
      "Show why one package depends on another. Useful for debugging closures.",
    inputSchema: {
      type: "object" as const,
      properties: {
        package: {
          type: "string",
          description: "The package to analyze",
        },
        dependency: {
          type: "string",
          description: "The dependency to look for",
        },
        working_directory: {
          type: "string",
          description: "Directory to run the command in",
        },
      },
      required: ["package", "dependency"],
    },
  },
  {
    name: "derivation_show",
    description:
      "Show the derivation(s) for an installable. Useful for debugging build issues.",
    inputSchema: {
      type: "object" as const,
      properties: {
        installable: {
          type: "string",
          description: "The installable to show derivation for",
        },
        working_directory: {
          type: "string",
          description: "Directory to run the command in",
        },
      },
      required: ["installable"],
    },
  },
  {
    name: "hash_path",
    description: "Compute the hash of a path.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path to hash",
        },
        type: {
          type: "string",
          enum: ["sha256", "sha512", "sha1", "md5"],
          description: "Hash algorithm (default: sha256)",
        },
        sri: {
          type: "boolean",
          description: "Output in SRI format",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "registry_list",
    description: "List flake registries and their entries.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "print_dev_env",
    description:
      "Print shell code that can be sourced to reproduce the build environment. Useful for IDE integration.",
    inputSchema: {
      type: "object" as const,
      properties: {
        installable: {
          type: "string",
          description: "The installable (defaults to current directory)",
        },
        json: {
          type: "boolean",
          description: "Output in JSON format",
        },
        working_directory: {
          type: "string",
          description: "Directory to run the command in",
        },
      },
    },
  },
  // Log retrieval
  {
    name: "get_log",
    description:
      "Retrieve the full output of a previous nix command. Use this when output was truncated and you need to see the full log.",
    inputSchema: {
      type: "object" as const,
      properties: {
        log_id: {
          type: "string",
          description: "The log ID from a previous command (shown in output footer)",
        },
        grep: {
          type: "string",
          description: "Optional: filter log lines matching this pattern",
        },
        tail: {
          type: "number",
          description: "Optional: only show last N lines",
        },
        head: {
          type: "number",
          description: "Optional: only show first N lines",
        },
        stream: {
          type: "string",
          enum: ["stdout", "stderr", "both"],
          description: "Which output stream to show (default: both)",
        },
      },
      required: ["log_id"],
    },
  },
  {
    name: "list_logs",
    description: "List available logs from previous nix commands.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "build_errors",
    description:
      "Extract error-relevant lines from a stored log. Returns only lines matching error patterns (error:, file:line:col, GHC codes, Rust errors, etc.) with surrounding context. Use this when you need to find the actual errors in a large build log.",
    inputSchema: {
      type: "object" as const,
      properties: {
        log_id: {
          type: "string",
          description: "The log ID from a previous command",
        },
        patterns: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: additional regex patterns to match as errors (added to built-in patterns)",
        },
        context: {
          type: "number",
          description:
            "Number of context lines around each error (default: 3)",
        },
        stream: {
          type: "string",
          enum: ["stdout", "stderr", "both"],
          description: "Which output stream to search (default: both)",
        },
      },
      required: ["log_id"],
    },
  },
  // --- Config commands ---
  {
    name: "config_show",
    description:
      "Show Nix configuration settings. Useful for debugging substituters, experimental-features, trusted users, etc.",
    inputSchema: {
      type: "object" as const,
      properties: {
        setting: {
          type: "string",
          description:
            "Specific setting to show (e.g., 'substituters', 'experimental-features'). Shows all if omitted.",
        },
        json: {
          type: "boolean",
          description: "Output in JSON format",
        },
      },
    },
  },
  {
    name: "config_check",
    description:
      "Check your system for potential Nix problems. Reports PASS/FAIL for each check.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  // --- Store commands ---
  {
    name: "store_ls",
    description:
      "List contents of a store path. Useful for inspecting what a build produced.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Store path to list (e.g., '/nix/store/...-hello-2.12')",
        },
        long: {
          type: "boolean",
          description: "Show detailed info including size",
        },
        json: {
          type: "boolean",
          description: "Output in JSON format",
        },
        recursive: {
          type: "boolean",
          description: "List recursively",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "store_cat",
    description:
      "Print the contents of a file inside a store path. Read files without copying them out of the store.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "Full path to a file in the store (e.g., '/nix/store/...-hello-2.12/bin/hello')",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "store_diff_closures",
    description:
      "Show what packages and versions were added/removed/changed between two closures. Great for understanding what an update changed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        before: {
          type: "string",
          description: "Store path or profile link for the 'before' state",
        },
        after: {
          type: "string",
          description: "Store path or profile link for the 'after' state",
        },
      },
      required: ["before", "after"],
    },
  },
  {
    name: "store_delete",
    description: "Delete paths from the Nix store.",
    inputSchema: {
      type: "object" as const,
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Store paths to delete",
        },
      },
      required: ["paths"],
    },
  },
  // --- Hash commands ---
  {
    name: "hash_file",
    description:
      "Compute the cryptographic hash of a file. Essential for writing fixed-output derivations and updating src hashes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path to the file to hash",
        },
        type: {
          type: "string",
          enum: ["sha256", "sha512", "sha1", "md5"],
          description: "Hash algorithm (default: sha256)",
        },
        sri: {
          type: "boolean",
          description: "Output in SRI format (recommended for Nix expressions)",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "hash_convert",
    description:
      "Convert between hash formats (SRI, base16, nix32, base64). Useful when Nix gives you a hash in one format but you need another.",
    inputSchema: {
      type: "object" as const,
      properties: {
        hash: {
          type: "string",
          description: "The hash to convert",
        },
        from: {
          type: "string",
          enum: ["sri", "base16", "nix32", "base64"],
          description: "Source format (auto-detected if omitted)",
        },
        to: {
          type: "string",
          enum: ["sri", "base16", "nix32", "base64"],
          description: "Target format (default: sri)",
        },
      },
      required: ["hash"],
    },
  },
  // --- Profile commands ---
  {
    name: "profile_history",
    description:
      "Show all versions of a profile. Useful for seeing what changed and deciding whether to rollback.",
    inputSchema: {
      type: "object" as const,
      properties: {
        profile: {
          type: "string",
          description: "Profile path (defaults to user profile)",
        },
      },
    },
  },
  {
    name: "profile_rollback",
    description:
      "Roll back to the previous version or a specified version of a profile.",
    inputSchema: {
      type: "object" as const,
      properties: {
        profile: {
          type: "string",
          description: "Profile path (defaults to user profile)",
        },
        to: {
          type: "number",
          description: "Specific generation number to roll back to",
        },
      },
    },
  },
  {
    name: "profile_diff_closures",
    description:
      "Show the closure difference between each version of a profile. Shows package additions, removals, and version changes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        profile: {
          type: "string",
          description: "Profile path (defaults to user profile)",
        },
      },
    },
  },
  // --- Copy command ---
  {
    name: "copy",
    description:
      "Copy store paths between Nix stores. Use this to push to binary caches or transfer between machines.",
    inputSchema: {
      type: "object" as const,
      properties: {
        installables: {
          type: "array",
          items: { type: "string" },
          description: "Store paths or installables to copy",
        },
        to: {
          type: "string",
          description:
            "Destination store URI (e.g., 's3://my-cache', 'ssh://server')",
        },
        from: {
          type: "string",
          description: "Source store URI (default: local store)",
        },
        no_check_sigs: {
          type: "boolean",
          description: "Don't require signatures on copied paths",
        },
      },
      required: ["installables"],
    },
  },
  // --- Flake commands (additional) ---
  {
    name: "flake_archive",
    description:
      "Copy a flake and all its inputs to a store. Use for offline work or pushing to binary caches.",
    inputSchema: {
      type: "object" as const,
      properties: {
        flake_ref: {
          type: "string",
          description: "Flake reference (defaults to current directory)",
        },
        to: {
          type: "string",
          description: "Destination store URI (e.g., 's3://my-cache')",
        },
        json: {
          type: "boolean",
          description: "Output in JSON format",
        },
        working_directory: {
          type: "string",
          description: "Directory to run the command in",
        },
      },
    },
  },
  {
    name: "flake_prefetch",
    description:
      "Download the source tree of a flake into the Nix store without building.",
    inputSchema: {
      type: "object" as const,
      properties: {
        flake_ref: {
          type: "string",
          description: "Flake reference to prefetch",
        },
        json: {
          type: "boolean",
          description: "Output in JSON format (includes store path and hash)",
        },
      },
      required: ["flake_ref"],
    },
  },
  {
    name: "flake_prefetch_inputs",
    description:
      "Fetch all inputs of a flake in parallel. Useful for CI pre-warming or preparing for offline work.",
    inputSchema: {
      type: "object" as const,
      properties: {
        flake_ref: {
          type: "string",
          description: "Flake reference (defaults to current directory)",
        },
        working_directory: {
          type: "string",
          description: "Directory to run the command in",
        },
      },
    },
  },
  {
    name: "flake_clone",
    description: "Clone a flake repository to a local directory.",
    inputSchema: {
      type: "object" as const,
      properties: {
        flake_ref: {
          type: "string",
          description: "Flake reference to clone",
        },
        dest: {
          type: "string",
          description: "Destination directory",
        },
      },
      required: ["flake_ref", "dest"],
    },
  },
  // --- Bundle command ---
  {
    name: "bundle",
    description:
      "Bundle an application so it works outside of the Nix store. Creates a standalone executable.",
    inputSchema: {
      type: "object" as const,
      properties: {
        installable: {
          type: "string",
          description: "The installable to bundle",
        },
        out_link: {
          type: "string",
          description: "Path for the output symlink",
        },
        working_directory: {
          type: "string",
          description: "Directory to run the command in",
        },
      },
      required: ["installable"],
    },
  },
  // --- Registry commands (additional) ---
  {
    name: "registry_add",
    description: "Add or replace a flake in the user flake registry.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Registry entry name",
        },
        flake_ref: {
          type: "string",
          description: "Flake reference to register",
        },
      },
      required: ["name", "flake_ref"],
    },
  },
  {
    name: "registry_pin",
    description:
      "Pin a flake registry entry to its current resolved version.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Registry entry name to pin",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "registry_remove",
    description: "Remove a flake from the user flake registry.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Registry entry name to remove",
        },
      },
      required: ["name"],
    },
  },
];

// Execute a nix command
async function execNix(
  args: string[],
  workingDirectory?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn("nix", args, {
      cwd: workingDirectory || process.cwd(),
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });

    proc.on("error", (err) => {
      resolve({
        stdout: "",
        stderr: err.message,
        exitCode: 1,
      });
    });
  });
}

const DRV_PATH_REGEX = /\/nix\/store\/[a-z0-9]+-[^\s']+\.drv/g;
const MAX_FETCHED_LOG_LINES = 200;

async function fetchBuildLog(
  stderr: string,
  workingDirectory?: string,
): Promise<string | null> {
  const drvPaths = stderr.match(DRV_PATH_REGEX);
  if (!drvPaths || drvPaths.length === 0) return null;

  // Deduplicate, take the last (most specific) derivation
  const uniqueDrvs = [...new Set(drvPaths)];
  const targetDrv = uniqueDrvs[uniqueDrvs.length - 1];

  try {
    const logResult = await execNix(["log", targetDrv], workingDirectory);
    if (logResult.exitCode !== 0 || !logResult.stdout.trim()) {
      return null;
    }
    const logLines = logResult.stdout.split("\n");
    if (logLines.length > MAX_FETCHED_LOG_LINES) {
      return extractErrorLines(logLines).join("\n");
    }
    return logResult.stdout;
  } catch {
    return null;
  }
}

// Tool handlers
async function handleTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "build": {
      const nixArgs = ["build"];
      if (args.installable) nixArgs.push(args.installable as string);
      if (args.out_link === "") nixArgs.push("--no-link");
      else if (args.out_link) nixArgs.push("-o", args.out_link as string);
      if (args.rebuild) nixArgs.push("--rebuild");
      const result = await execNix(nixArgs, args.working_directory as string);
      if (result.exitCode !== 0) {
        const buildLog = await fetchBuildLog(result.stderr, args.working_directory as string);
        if (buildLog) {
          result.stderr += "\n\n--- Build log (auto-fetched) ---\n" + buildLog;
        }
      }
      return formatResult(nixArgs.join(" "), result);
    }

    case "develop": {
      const nixArgs = ["develop"];
      if (args.installable) nixArgs.push(args.installable as string);
      if (args.command) nixArgs.push("-c", "sh", "-c", args.command as string);
      const result = await execNix(nixArgs, args.working_directory as string);
      if (result.exitCode !== 0) {
        const buildLog = await fetchBuildLog(result.stderr, args.working_directory as string);
        if (buildLog) {
          result.stderr += "\n\n--- Build log (auto-fetched) ---\n" + buildLog;
        }
      }
      return formatResult(nixArgs.join(" "), result);
    }

    case "run": {
      const nixArgs = ["run", args.installable as string];
      if (args.args) nixArgs.push("--", ...(args.args as string[]));
      const result = await execNix(nixArgs, args.working_directory as string);
      return formatResult(nixArgs.join(" "), result);
    }

    case "search": {
      const nixArgs = ["search"];
      nixArgs.push((args.installable as string) || "nixpkgs");
      nixArgs.push(args.regex as string);
      if (args.json) nixArgs.push("--json");
      const result = await execNix(nixArgs, args.working_directory as string);
      return formatResult(nixArgs.join(" "), result);
    }

    case "flake_init": {
      const nixArgs = ["flake", "init"];
      if (args.template) nixArgs.push("-t", args.template as string);
      const result = await execNix(nixArgs, args.working_directory as string);
      return formatResult(nixArgs.join(" "), result);
    }

    case "flake_new": {
      const nixArgs = ["flake", "new", args.path as string];
      if (args.template) nixArgs.push("-t", args.template as string);
      const result = await execNix(nixArgs, args.working_directory as string);
      return formatResult(nixArgs.join(" "), result);
    }

    case "flake_show": {
      const nixArgs = ["flake", "show"];
      if (args.flake_ref) nixArgs.push(args.flake_ref as string);
      if (args.json) nixArgs.push("--json");
      const result = await execNix(nixArgs, args.working_directory as string);
      return formatResult(nixArgs.join(" "), result);
    }

    case "flake_metadata": {
      const nixArgs = ["flake", "metadata"];
      if (args.flake_ref) nixArgs.push(args.flake_ref as string);
      if (args.json) nixArgs.push("--json");
      const result = await execNix(nixArgs, args.working_directory as string);
      return formatResult(nixArgs.join(" "), result);
    }

    case "flake_update": {
      const nixArgs = ["flake", "update"];
      if (args.inputs) {
        for (const input of args.inputs as string[]) {
          nixArgs.push(input);
        }
      }
      const result = await execNix(nixArgs, args.working_directory as string);
      return formatResult(nixArgs.join(" "), result);
    }

    case "flake_check": {
      const nixArgs = ["flake", "check"];
      if (args.flake_ref) nixArgs.push(args.flake_ref as string);
      const result = await execNix(nixArgs, args.working_directory as string);
      if (result.exitCode !== 0) {
        const buildLog = await fetchBuildLog(result.stderr, args.working_directory as string);
        if (buildLog) {
          result.stderr += "\n\n--- Build log (auto-fetched) ---\n" + buildLog;
        }
      }
      return formatResult(nixArgs.join(" "), result);
    }

    case "flake_lock": {
      const nixArgs = ["flake", "lock"];
      if (args.flake_ref) nixArgs.push(args.flake_ref as string);
      const result = await execNix(nixArgs, args.working_directory as string);
      return formatResult(nixArgs.join(" "), result);
    }

    case "eval": {
      const nixArgs = ["eval"];
      if (args.installable) nixArgs.push(args.installable as string);
      if (args.expr) nixArgs.push("--expr", args.expr as string);
      if (args.json) nixArgs.push("--json");
      if (args.raw) nixArgs.push("--raw");
      const result = await execNix(nixArgs, args.working_directory as string);
      return formatResult(nixArgs.join(" "), result);
    }

    case "profile_list": {
      const nixArgs = ["profile", "list"];
      if (args.profile) nixArgs.push("--profile", args.profile as string);
      if (args.json) nixArgs.push("--json");
      const result = await execNix(nixArgs);
      return formatResult(nixArgs.join(" "), result);
    }

    case "profile_add":
    case "profile_install": {
      const nixArgs = ["profile", "install"];
      if (args.profile) nixArgs.push("--profile", args.profile as string);
      nixArgs.push(...(args.installables as string[]));
      const result = await execNix(nixArgs);
      return formatResult(nixArgs.join(" "), result);
    }

    case "profile_remove": {
      const nixArgs = ["profile", "remove"];
      if (args.profile) nixArgs.push("--profile", args.profile as string);
      nixArgs.push(...(args.packages as string[]));
      const result = await execNix(nixArgs);
      return formatResult(nixArgs.join(" "), result);
    }

    case "profile_upgrade": {
      const nixArgs = ["profile", "upgrade"];
      if (args.profile) nixArgs.push("--profile", args.profile as string);
      nixArgs.push(...(args.packages as string[]));
      const result = await execNix(nixArgs);
      return formatResult(nixArgs.join(" "), result);
    }

    case "store_gc": {
      const nixArgs = ["store", "gc"];
      if (args.dry_run) nixArgs.push("--dry-run");
      const result = await execNix(nixArgs);
      return formatResult(nixArgs.join(" "), result);
    }

    case "store_path_info": {
      const nixArgs = ["path-info"];
      nixArgs.push(...(args.paths as string[]));
      if (args.json) nixArgs.push("--json");
      if (args.closure_size) nixArgs.push("-S");
      const result = await execNix(nixArgs);
      return formatResult(nixArgs.join(" "), result);
    }

    case "fmt": {
      const nixArgs = ["fmt"];
      const result = await execNix(nixArgs, args.working_directory as string);
      return formatResult(nixArgs.join(" "), result);
    }

    case "log": {
      const nixArgs = ["log", args.installable as string];
      const result = await execNix(nixArgs, args.working_directory as string);
      return formatResult(nixArgs.join(" "), result);
    }

    case "why_depends": {
      const nixArgs = [
        "why-depends",
        args.package as string,
        args.dependency as string,
      ];
      const result = await execNix(nixArgs, args.working_directory as string);
      return formatResult(nixArgs.join(" "), result);
    }

    case "derivation_show": {
      const nixArgs = ["derivation", "show", args.installable as string];
      const result = await execNix(nixArgs, args.working_directory as string);
      return formatResult(nixArgs.join(" "), result);
    }

    case "hash_path": {
      const nixArgs = ["hash", "path", args.path as string];
      if (args.type) nixArgs.push("--type", args.type as string);
      if (args.sri) nixArgs.push("--sri");
      const result = await execNix(nixArgs);
      return formatResult(nixArgs.join(" "), result);
    }

    case "registry_list": {
      const nixArgs = ["registry", "list"];
      const result = await execNix(nixArgs);
      return formatResult(nixArgs.join(" "), result);
    }

    case "print_dev_env": {
      const nixArgs = ["print-dev-env"];
      if (args.installable) nixArgs.push(args.installable as string);
      if (args.json) nixArgs.push("--json");
      const result = await execNix(nixArgs, args.working_directory as string);
      return formatResult(nixArgs.join(" "), result);
    }

    case "get_log": {
      const logId = args.log_id as string;
      const entry = logStore.get(logId);
      if (!entry) {
        return `Log not found: ${logId}\nUse nix_list_logs to see available logs.`;
      }

      const stream = (args.stream as string) || "both";
      let output: string;
      if (stream === "stdout") {
        output = entry.stdout;
      } else if (stream === "stderr") {
        output = entry.stderr;
      } else {
        output = entry.stdout + (entry.stderr ? "\n" + entry.stderr : "");
      }

      // Apply grep filter
      if (args.grep) {
        const pattern = new RegExp(args.grep as string, "i");
        output = output
          .split("\n")
          .filter((line) => pattern.test(line))
          .join("\n");
      }

      // Apply head/tail
      let lines = output.split("\n");
      if (args.head) {
        lines = lines.slice(0, args.head as number);
      }
      if (args.tail) {
        lines = lines.slice(-(args.tail as number));
      }

      return [
        `Command: nix ${entry.command}`,
        `Exit code: ${entry.exitCode}`,
        `Timestamp: ${entry.timestamp}`,
        "",
        lines.join("\n"),
      ].join("\n");
    }

    case "list_logs": {
      const logs = Array.from(logStore.values())
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, 20);

      if (logs.length === 0) {
        return "No logs available.";
      }

      return logs
        .map(
          (log) =>
            `[${log.id}] ${log.timestamp} - nix ${log.command.slice(0, 50)}${log.command.length > 50 ? "..." : ""} (exit: ${log.exitCode})`
        )
        .join("\n");
    }

    case "build_errors": {
      const logId = args.log_id as string;
      const entry = logStore.get(logId);
      if (!entry) {
        return `Log not found: ${logId}\nUse nix_list_logs to see available logs.`;
      }

      // Early return for successful commands unless custom patterns requested
      if (entry.exitCode === 0 && !args.patterns) {
        return [
          `Command: nix ${entry.command}`,
          `Exit code: 0`,
          "",
          "No errors — command completed successfully.",
        ].join("\n");
      }

      const stream = (args.stream as string) || "both";
      let output: string;
      if (stream === "stdout") output = entry.stdout;
      else if (stream === "stderr") output = entry.stderr;
      else output = entry.stdout + (entry.stderr ? "\n" + entry.stderr : "");

      const lines = output.split("\n");

      // Build pattern list: built-in + user-supplied
      const patterns = [...ERROR_PATTERNS];
      if (args.patterns) {
        for (const p of args.patterns as string[]) {
          try {
            patterns.push(new RegExp(p));
          } catch {
            // Skip invalid regex
          }
        }
      }

      // Check if any lines actually match error patterns before extracting
      const hasErrors = lines.some((line) =>
        patterns.some((p) => p.test(line)),
      );
      if (!hasErrors) {
        return [
          `Command: nix ${entry.command}`,
          `Exit code: ${entry.exitCode}`,
          "",
          "No error patterns found in log output.",
          "Use get_log to see the full output.",
        ].join("\n");
      }

      const contextSize = (args.context as number) ?? 3;
      const extracted = extractErrorLines(lines, patterns, contextSize, contextSize);

      return [
        `Command: nix ${entry.command}`,
        `Exit code: ${entry.exitCode}`,
        `Errors found:`,
        "",
        ...extracted,
      ].join("\n");
    }

    // --- Config commands ---

    case "config_show": {
      const nixArgs = ["config", "show"];
      if (args.setting) nixArgs.push(args.setting as string);
      if (args.json) nixArgs.push("--json");
      const result = await execNix(nixArgs);
      return formatResult(nixArgs.join(" "), result);
    }

    case "config_check": {
      const nixArgs = ["config", "check"];
      const result = await execNix(nixArgs);
      return formatResult(nixArgs.join(" "), result);
    }

    // --- Store commands ---

    case "store_ls": {
      const nixArgs = ["store", "ls"];
      if (args.long) nixArgs.push("-l");
      if (args.json) nixArgs.push("--json");
      if (args.recursive) nixArgs.push("-R");
      nixArgs.push(args.path as string);
      const result = await execNix(nixArgs);
      return formatResult(nixArgs.join(" "), result);
    }

    case "store_cat": {
      const nixArgs = ["store", "cat", args.path as string];
      const result = await execNix(nixArgs);
      return formatResult(nixArgs.join(" "), result);
    }

    case "store_diff_closures": {
      const nixArgs = [
        "store",
        "diff-closures",
        args.before as string,
        args.after as string,
      ];
      const result = await execNix(nixArgs);
      return formatResult(nixArgs.join(" "), result);
    }

    case "store_delete": {
      const nixArgs = ["store", "delete"];
      nixArgs.push(...(args.paths as string[]));
      const result = await execNix(nixArgs);
      return formatResult(nixArgs.join(" "), result);
    }

    // --- Hash commands ---

    case "hash_file": {
      const nixArgs = ["hash", "file", args.path as string];
      if (args.type) nixArgs.push("--type", args.type as string);
      if (args.sri) nixArgs.push("--sri");
      const result = await execNix(nixArgs);
      return formatResult(nixArgs.join(" "), result);
    }

    case "hash_convert": {
      const nixArgs = ["hash", "convert"];
      if (args.from) nixArgs.push("--from", args.from as string);
      if (args.to) nixArgs.push("--to", args.to as string);
      nixArgs.push(args.hash as string);
      const result = await execNix(nixArgs);
      return formatResult(nixArgs.join(" "), result);
    }

    // --- Profile commands ---

    case "profile_history": {
      const nixArgs = ["profile", "history"];
      if (args.profile) nixArgs.push("--profile", args.profile as string);
      const result = await execNix(nixArgs);
      return formatResult(nixArgs.join(" "), result);
    }

    case "profile_rollback": {
      const nixArgs = ["profile", "rollback"];
      if (args.profile) nixArgs.push("--profile", args.profile as string);
      if (args.to !== undefined) nixArgs.push("--to", String(args.to));
      const result = await execNix(nixArgs);
      return formatResult(nixArgs.join(" "), result);
    }

    case "profile_diff_closures": {
      const nixArgs = ["profile", "diff-closures"];
      if (args.profile) nixArgs.push("--profile", args.profile as string);
      const result = await execNix(nixArgs);
      return formatResult(nixArgs.join(" "), result);
    }

    // --- Copy command ---

    case "copy": {
      const nixArgs = ["copy"];
      if (args.to) nixArgs.push("--to", args.to as string);
      if (args.from) nixArgs.push("--from", args.from as string);
      if (args.no_check_sigs) nixArgs.push("--no-check-sigs");
      nixArgs.push(...(args.installables as string[]));
      const result = await execNix(nixArgs);
      return formatResult(nixArgs.join(" "), result);
    }

    // --- Flake commands (additional) ---

    case "flake_archive": {
      const nixArgs = ["flake", "archive"];
      if (args.flake_ref) nixArgs.push(args.flake_ref as string);
      if (args.to) nixArgs.push("--to", args.to as string);
      if (args.json) nixArgs.push("--json");
      const result = await execNix(nixArgs, args.working_directory as string);
      return formatResult(nixArgs.join(" "), result);
    }

    case "flake_prefetch": {
      const nixArgs = ["flake", "prefetch", args.flake_ref as string];
      if (args.json) nixArgs.push("--json");
      const result = await execNix(nixArgs);
      return formatResult(nixArgs.join(" "), result);
    }

    case "flake_prefetch_inputs": {
      const nixArgs = ["flake", "prefetch-inputs"];
      if (args.flake_ref) nixArgs.push(args.flake_ref as string);
      const result = await execNix(nixArgs, args.working_directory as string);
      return formatResult(nixArgs.join(" "), result);
    }

    case "flake_clone": {
      const nixArgs = [
        "flake",
        "clone",
        args.flake_ref as string,
        "--dest",
        args.dest as string,
      ];
      const result = await execNix(nixArgs);
      return formatResult(nixArgs.join(" "), result);
    }

    // --- Bundle command ---

    case "bundle": {
      const nixArgs = ["bundle", args.installable as string];
      if (args.out_link) nixArgs.push("-o", args.out_link as string);
      const result = await execNix(nixArgs, args.working_directory as string);
      return formatResult(nixArgs.join(" "), result);
    }

    // --- Registry commands (additional) ---

    case "registry_add": {
      const nixArgs = [
        "registry",
        "add",
        args.name as string,
        args.flake_ref as string,
      ];
      const result = await execNix(nixArgs);
      return formatResult(nixArgs.join(" "), result);
    }

    case "registry_pin": {
      const nixArgs = ["registry", "pin", args.name as string];
      const result = await execNix(nixArgs);
      return formatResult(nixArgs.join(" "), result);
    }

    case "registry_remove": {
      const nixArgs = ["registry", "remove", args.name as string];
      const result = await execNix(nixArgs);
      return formatResult(nixArgs.join(" "), result);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const MAX_OUTPUT_LINES = 50;
const MAX_OUTPUT_CHARS = 4000;

const ERROR_PATTERNS: RegExp[] = [
  /\berror:/i,
  /\berror\[E\d+\]/,          // Rust error codes
  /\bGHC-\d+/,                // Haskell error codes
  /\.\w+:\d+:\d+:/,           // file:line:col (general)
  /\bwarning:/,               // compiler warnings
  /\bundefined reference/i,   // linker errors
  /\bfailed\b/i,              // generic failure indicators
  /^\s*\|/,                   // Rust/GHC error context lines (pipe-indented)
];

const CONTEXT_LINES_BEFORE = 2;
const CONTEXT_LINES_AFTER = 3;
const ORIENTATION_LINES = 5;
const MAX_ERROR_TRUNCATED_LINES = 80;

function extractErrorLines(
  lines: string[],
  patterns: RegExp[] = ERROR_PATTERNS,
  contextBefore: number = CONTEXT_LINES_BEFORE,
  contextAfter: number = CONTEXT_LINES_AFTER,
): string[] {
  // Find all line indices matching any error pattern
  const errorIndices: Set<number> = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (patterns.some((p) => p.test(lines[i]))) {
      errorIndices.add(i);
    }
  }

  // No errors found -> fallback to first/last split
  if (errorIndices.size === 0) {
    const keep = Math.floor(MAX_OUTPUT_LINES / 2);
    const removed = lines.length - keep * 2;
    return [
      ...lines.slice(0, keep),
      `... (${removed} lines omitted) ...`,
      ...lines.slice(-keep),
    ];
  }

  // Build "keep" set: error lines + context + orientation
  const keepSet: Set<number> = new Set();

  // Orientation: first and last N lines
  for (let i = 0; i < Math.min(ORIENTATION_LINES, lines.length); i++) {
    keepSet.add(i);
  }
  for (let i = Math.max(0, lines.length - ORIENTATION_LINES); i < lines.length; i++) {
    keepSet.add(i);
  }

  // Error lines + context
  for (const idx of errorIndices) {
    for (
      let i = Math.max(0, idx - contextBefore);
      i <= Math.min(lines.length - 1, idx + contextAfter);
      i++
    ) {
      keepSet.add(i);
    }
  }

  // If too many kept lines, reduce context progressively
  if (keepSet.size > MAX_ERROR_TRUNCATED_LINES) {
    keepSet.clear();
    for (let i = 0; i < Math.min(ORIENTATION_LINES, lines.length); i++) {
      keepSet.add(i);
    }
    for (let i = Math.max(0, lines.length - ORIENTATION_LINES); i < lines.length; i++) {
      keepSet.add(i);
    }
    // Keep only error lines + 1 line context
    for (const idx of errorIndices) {
      for (
        let i = Math.max(0, idx - 1);
        i <= Math.min(lines.length - 1, idx + 1);
        i++
      ) {
        keepSet.add(i);
      }
    }
  }

  // Build output with gap markers
  const sortedKeep = [...keepSet].sort((a, b) => a - b);
  const result: string[] = [];
  let lastIdx = -1;

  for (const idx of sortedKeep) {
    if (lastIdx !== -1 && idx > lastIdx + 1) {
      const gapSize = idx - lastIdx - 1;
      result.push(`... (${gapSize} lines omitted) ...`);
    }
    result.push(lines[idx]);
    lastIdx = idx;
  }

  return result;
}

let logCounter = 0;

function storeLog(
  command: string,
  result: { stdout: string; stderr: string; exitCode: number }
): string {
  // Generate short ID
  const id = `log-${++logCounter}`;

  // Clean up old logs if needed
  if (logStore.size >= MAX_LOGS) {
    const oldest = Array.from(logStore.keys())[0];
    logStore.delete(oldest);
  }

  logStore.set(id, {
    id,
    command,
    timestamp: new Date().toISOString(),
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  });

  return id;
}

function formatResult(
  command: string,
  result: {
    stdout: string;
    stderr: string;
    exitCode: number;
  }
): string {
  // Store full log in memory first
  const fullOutput = result.stdout + result.stderr;
  const needsLog = fullOutput.length > MAX_OUTPUT_CHARS || fullOutput.split("\n").length > MAX_OUTPUT_LINES;
  const logId = needsLog ? storeLog(command, result) : null;

  let output = "";

  if (result.stdout) {
    output += result.stdout;
  }

  if (result.stderr) {
    // Filter out noise from nix output
    const filteredStderr = result.stderr
      .split("\n")
      .filter((line) => {
        // Filter experimental warnings
        if (line.includes("Warning") && line.includes("experimental")) return false;
        // Filter progress bars and ANSI escape sequences
        if (line.includes("\x1b[") || line.includes("\r")) return false;
        // Filter "copying path" messages (too verbose)
        if (line.match(/^copying path/)) return false;
        // Filter download progress
        if (line.match(/^\s*\d+(\.\d+)?\s*(KiB|MiB|GiB)/)) return false;
        // Filter evaluation traces (e.g., "evaluating 'legacyPackages...'" — can be 100k+ lines)
        if (line.match(/^\s*evaluating '/)) return false;
        // Filter "Using saved setting" messages from trusted-settings.json
        if (line.match(/^\s*Using saved setting/)) return false;
        // Filter nixpkgs rename/deprecation warnings (not actionable)
        if (line.match(/^\s*evaluation warning:.*renamed to/)) return false;
        if (line.match(/^\s*evaluation warning:.*was removed/)) return false;
        if (line.match(/^\s*evaluation warning:.*is deprecated/)) return false;
        // Filter substituter/cache auth failures (noisy, not actionable by agent)
        if (line.match(/^\s*warning: unable to download/)) return false;
        return true;
      })
      .join("\n")
      .trim();

    if (filteredStderr) {
      output += (output ? "\n" : "") + filteredStderr;
    }
  }

  // Truncate if too long
  let lines = output.split("\n");
  let truncated = false;

  if (lines.length > MAX_OUTPUT_LINES) {
    if (result.exitCode !== 0) {
      // Error-aware truncation: prioritize error lines over noise
      lines = extractErrorLines(lines);
    } else {
      // Success output: keep first/last halves
      const keepLines = Math.floor(MAX_OUTPUT_LINES / 2);
      const removed = lines.length - MAX_OUTPUT_LINES;
      lines = [
        ...lines.slice(0, keepLines),
        `... (${removed} lines omitted) ...`,
        ...lines.slice(-keepLines),
      ];
    }
    truncated = true;
  }

  output = lines.join("\n");

  if (output.length > MAX_OUTPUT_CHARS) {
    const keepChars = Math.floor(MAX_OUTPUT_CHARS / 2);
    const removed = output.length - MAX_OUTPUT_CHARS;
    output =
      output.slice(0, keepChars) +
      `\n... (${removed} characters omitted) ...\n` +
      output.slice(-keepChars);
    truncated = true;
  }

  // Add status footer
  const statusParts: string[] = [];
  if (result.exitCode !== 0) {
    statusParts.push(`Exit code: ${result.exitCode}`);
  }
  if (logId) {
    statusParts.push(`Full log: use nix_get_log with id="${logId}"`);
  }

  if (statusParts.length > 0) {
    output += "\n\n[" + statusParts.join(" | ") + "]";
  }

  return output || "Command completed successfully";
}

// Prompts for guiding AI assistants
const prompts = [
  {
    name: "nix-workflow",
    description:
      "Instructions for using Nix flakes for development. Read this first when working with Nix projects.",
  },
  {
    name: "flake-template",
    description: "Template for creating a new flake.nix file",
    arguments: [
      {
        name: "language",
        description: "Programming language (rust, python, go, nodejs, etc.)",
        required: false,
      },
    ],
  },
];

const nixWorkflowPrompt = `# Nix Flake-Based Development Workflow

This project uses Nix flakes for reproducible builds and development environments.
Always use the modern \`nix\` command (NOT legacy nix-shell, nix-build, nix-env).

## Key Principles

1. **Flakes are the standard** - Every Nix project should have a \`flake.nix\` at its root
2. **Use nix develop** - Enter dev shells with \`nix develop\`, run commands with \`nix develop -c <cmd>\`
3. **Use nix build** - Build projects with \`nix build\`, not language-specific build tools directly
4. **Use nix flake check** - Validate flakes and run tests with \`nix flake check\`

## Common Workflow

### Starting a new project
1. \`nix flake init -t templates#<language>\` or create flake.nix manually
2. \`nix flake lock\` to create lock file
3. Add flake.nix and flake.lock to git

### Development
1. \`nix develop\` - Enter the dev shell with all dependencies
2. \`nix develop -c <command>\` - Run a single command in the dev shell
3. \`nix build\` - Build the project
4. \`nix run\` - Run the default app

### Checking/Testing
1. \`nix flake check\` - Run all checks defined in the flake
2. \`nix flake show\` - See what outputs the flake provides

### Updating dependencies
1. \`nix flake update\` - Update all inputs
2. \`nix flake update <input>\` - Update specific input

## Important Notes

- Always check for existing flake.nix before suggesting other build methods
- Use \`nix develop -c\` to run build commands within the flake's environment
- Prefer \`nix build\` over direct invocation of cargo/npm/make etc.
- The dev shell provides all necessary tools - don't install them globally
`;

function getFlakeTemplate(language?: string): string {
  const templates: Record<string, string> = {
    rust: `{
  description = "Rust project";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, rust-overlay }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs { inherit system overlays; };
        rustToolchain = pkgs.rust-bin.stable.latest.default;
      in {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            rustToolchain
            rust-analyzer
            pkg-config
          ];
        };

        packages.default = pkgs.rustPlatform.buildRustPackage {
          pname = "myproject";
          version = "0.1.0";
          src = ./.;
          cargoLock.lockFile = ./Cargo.lock;
        };
      });
}`,
    python: `{
  description = "Python project";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        python = pkgs.python312;
      in {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            python
            python.pkgs.pip
            python.pkgs.virtualenv
          ];
        };
      });
}`,
    go: `{
  description = "Go project";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            go
            gopls
            gotools
          ];
        };

        packages.default = pkgs.buildGoModule {
          pname = "myproject";
          version = "0.1.0";
          src = ./.;
          vendorHash = null; # Update after first build
        };
      });
}`,
    nodejs: `{
  description = "Node.js project";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs_22
            nodePackages.typescript
            nodePackages.typescript-language-server
          ];
        };
      });
}`,
    default: `{
  description = "A Nix flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            # Add your dependencies here
          ];
        };

        packages.default = pkgs.stdenv.mkDerivation {
          pname = "myproject";
          version = "0.1.0";
          src = ./.;
          # Add build instructions
        };
      });
}`,
  };

  const template = templates[language?.toLowerCase() || "default"] || templates.default;
  return `# Flake Template for ${language || "generic"} project

\`\`\`nix
${template}
\`\`\`

## Usage

1. Save this as \`flake.nix\` in your project root
2. Run \`nix flake lock\` to generate the lock file
3. Run \`nix develop\` to enter the development shell
4. Run \`nix build\` to build the project
`;
}

// Create and run server
const server = new Server(
  {
    name: "nix-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
    },
  }
);

// Register handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const result = await handleTool(name, args as Record<string, unknown>);
    return {
      content: [{ type: "text", text: result }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts,
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: promptArgs } = request.params;

  switch (name) {
    case "nix-workflow":
      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text: nixWorkflowPrompt },
          },
        ],
      };
    case "flake-template":
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: getFlakeTemplate(promptArgs?.language as string | undefined),
            },
          },
        ],
      };
    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("nix-mcp server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
