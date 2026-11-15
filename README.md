# Canvas MCP

Canvas MCP is a set of tools that allows your AI agents to interact with Canvas LMS and Gradescope.

![gradescope](assets/gradescope_mcp_ant.png)

![example](assets/example.png)

## Features

- **Find relevant resources** - Ability to find relevant resources for a given query in natural language!
- **Query upcoming assignments** - Not only fetch upcoming assignments, but also provide its breakdown for a given course.
- **Get courses and assignments from Gradescope** - Query your Gradescope courses and assignments with natural language, get submission status, and more!
- Get courses
- Get modules
- Get module items
- Get file url
- Get calendar events
- Get assignments
- and so much more... 

## Usage

Note down the following beforehand:
1. Canvas API Key from `Canvas > Account > Settings > Approved Integrations > New Access Token`
2. Gradescope Email and Password https://www.gradescope.com/
   
### Installing via Smithery (**Preferred**)

To install Canvas MCP for Claude Code via [Smithery](https://smithery.ai/server/aryankeluskar/canvas-mcp):

```bash
npx -y @smithery/cli@latest mcp add aryankeluskar/canvas-mcp --client claude-code
```

Or, for Cursor IDE to use canvas-mcp with other models:

```bash
npx -y @smithery/cli install aryankeluskar/canvas-mcp --client cursor
```

Or, for ChatGPT:


1) Enable Developer Mode in settings, if not already enabled
2) Go to `ChatGPT Settings > Connectors` and click Create to add this server URL: `https://canvas-mcp--aryankeluskar.run.tools`

---


### Manual Configuration (ONLY for local instances)

Create a `.env` file in the root directory with the following environment variables:

```
SNITHERY_API_KEY=your_snithery_api_key
```

Add the following to your `mcp.json` or `claude_desktop_config.json` file:

```json
{
  "mcpServers": {
      "canvas": {
          "command": "npx",
          "args": [
              "-y",
              "@smithery/cli",
              "run",
              "@aryankeluskar/canvas-mcp"
          ]
      }
  }
}
```

---

## Run in the background (macOS)

So the server starts at login and you don't need to keep a Terminal window open:

```bash
scripts/launchagent.sh install    # generate + start the LaunchAgent
scripts/launchagent.sh status     # check it is running
scripts/launchagent.sh restart    # reload after code changes
scripts/launchagent.sh stop       # stop it
scripts/launchagent.sh uninstall  # stop and remove
```

This installs a user-level LaunchAgent (no root required) that:

- starts automatically when you log in and restarts if it crashes
- reads credentials from `.dev.vars` in the repository checkout (nothing is copied or committed)
- logs to `~/Library/Logs/canvas-mcp/`
- keeps the MCP endpoint available at `http://localhost:8787/mcp`

If you previously ran `npm start` manually, stop it first so the LaunchAgent can bind port 8787.

Note: the generated plist stores the absolute path of the Node.js binary resolved at install time. If you switch or upgrade your Node installation (e.g. via Homebrew or a version manager), rerun `scripts/launchagent.sh install` and then `restart`.

---

Built by [Aryan Keluskar](https://aryankeluskar.com) :)
