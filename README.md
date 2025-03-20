# Canvas MCP

Canvas MCP is a set of tools that allows your AI agents to interact with Canvas LMS.

![example](example.png)

## Features

- **Find relevant resources** - Find relevant resources for a given query in natural language.
- Get courses
- Get modules
- Get module items
- Get file url
- Get calendar events (coming soon)
- Get assignments (coming soon)
- Get course analysis (coming soon)
- Get module analysis (coming soon)
- Get resource analysis (coming soon)

## Usage

Add the following to your `mcp.json` or `claude_desktop_config.json` file:

```json
{
  "mcpServers": {
      "canvas": {
          "command": "uv",
          "args": [
              "--directory",
              "/Users/aryank/Developer/canvas-mcp",
              "run",
              "canvas.py"
          ]
      }
  }
}
```

## Installation

Download the repository and run the following commands:

```bash
git clone https://github.com/aryankeluskar/canvas-mcp.git
cd canvas-mcp

# Install dependencies with uv (recommended)
pip install uv
uv venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
uv pip install -r requirements.txt

# Or install with pip
pip install -r requirements.txt
```

## Configuration

Create a `.env` file in the root directory with the following environment variables:

```
CANVAS_API_KEY=your_canvas_api_key
GEMINI_API_KEY=your_gemini_api_key
```

- Get your Canvas API key from your Canvas LMS account settings
- Get your Gemini API key from https://aistudio.google.com/app/apikey

## API Usage

```python
from canvas import get_courses, find_resources, get_modules, get_module_items

# Get all courses
courses = await get_courses()

# Find resources relevant to a query
resources = await find_resources("What is the meaning of life?")

# Get modules for a course
modules = await get_modules("course_id")

# Get items in a module
items = await get_module_items("course_id", "module_id")
```

---

Built by [Aryan Keluskar](https://aryankeluskar.com) :)