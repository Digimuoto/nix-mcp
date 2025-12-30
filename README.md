# nix-mcp

MCP server for nix commands. Enables AI assistants to use Nix flakes for building and development.

**Flake-based development only.** Uses the modern `nix` command (NOT legacy nix-shell, nix-build, nix-env).

## Installation

```bash
npm install
npm run build
```

## Usage

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "nix": {
      "command": "npx",
      "args": ["-y", "github:Digimuoto/nix-mcp"]
    }
  }
}
```

## Prompts

| Prompt | Description |
|--------|-------------|
| `nix-workflow` | Instructions for flake-based development |
| `flake-template` | Templates for flake.nix (rust, python, go, nodejs) |

## Tools

### Core

| Tool | Description |
|------|-------------|
| `build` | Build a derivation or fetch a store path |
| `develop` | Run commands in a development shell |
| `run` | Run a Nix application directly |
| `search` | Search for packages |

### Flake

| Tool | Description |
|------|-------------|
| `flake_init` | Initialize a new flake from a template |
| `flake_new` | Create a new flake in a new directory |
| `flake_show` | Show flake outputs |
| `flake_metadata` | Show flake metadata |
| `flake_update` | Update flake inputs |
| `flake_check` | Check a flake for issues |
| `flake_lock` | Create/update lock file |

### Evaluation & Debugging

| Tool | Description |
|------|-------------|
| `eval` | Evaluate a Nix expression |
| `derivation_show` | Show derivation details |
| `log` | Show build logs |
| `why_depends` | Show dependency chain |

### Profile

| Tool | Description |
|------|-------------|
| `profile_list` | List installed packages |
| `profile_install` | Install packages |
| `profile_remove` | Remove packages |
| `profile_upgrade` | Upgrade packages |

### Store

| Tool | Description |
|------|-------------|
| `store_gc` | Garbage collect |
| `store_path_info` | Query store paths |

### Utilities

| Tool | Description |
|------|-------------|
| `fmt` | Format Nix files |
| `hash_path` | Compute path hash |
| `registry_list` | List flake registries |
| `print_dev_env` | Print dev environment |

### Log Management

Output is truncated to prevent context flooding. Use these to access full logs:

| Tool | Description |
|------|-------------|
| `get_log` | Retrieve full output (supports grep/head/tail) |
| `list_logs` | List available logs |

## License

MIT
