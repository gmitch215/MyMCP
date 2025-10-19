# MyMCP - OpenAPI to MCP Server Converter

[![Deploy to Cloudflare Workers](https://img.shields.io/badge/Deploy%20to-Cloudflare%20Workers-orange)](https://workers.cloudflare.com/)

**MyMCP** is a powerful serverless application that dynamically converts any OpenAPI specification into a fully-functional Model Context Protocol (MCP) server. Deploy it once, and instantly expose any OpenAPI-compliant API as an MCP-compatible interface with tools, streaming, and more.

🌐 **Live Instance**: [mymcp.gmitch215.xyz](https://mymcp.gmitch215.xyz)

---

## 📋 Table of Contents

- [Features](#-features)
- [How It Works](#-how-it-works)
- [Getting Started](#-getting-started)
- [Usage](#-usage)
- [Pre-configured Servers](#-pre-configured-servers)
- [Deployment](#-deployment)
- [License](#-license)

---

## ✨ Features

- **🔄 Dynamic OpenAPI Conversion**: Automatically converts any OpenAPI 3.x specification into MCP tools
- **🚀 Serverless Architecture**: Runs on Cloudflare Workers for global edge deployment
- **🔌 Tool Generation**: Each OpenAPI endpoint becomes an invocable MCP tool
- **📡 Streaming Support**: WebSocket-based streaming for long-running operations
- **🌐 MCP Protocol Compatible**: Full support for official MCP protocol via SSE + JSON-RPC 2.0
- **🔒 Authentication**: Supports API key, Bearer token, and OAuth2 schemes
- **📊 Built-in Metrics**: Track usage, errors, and performance
- **💾 Smart Caching**: OpenAPI documents cached for optimal performance
- **🛡️ Type Safety**: Full TypeScript implementation with comprehensive types
- **🌍 CORS Enabled**: Works seamlessly with web-based MCP clients
- **📝 Parameter Validation**: Validates required parameters before API calls
- **🔧 Multiple Content Types**: Handles JSON, XML, form data, and more
- **🔗 Path & Query Parameters**: Full support for OpenAPI parameter types
- **🤖 Works with Claude, Cursor, Windsurf**: Compatible with all major MCP clients

---

## 🎯 How It Works

1. **Point to OpenAPI Spec**: Access any OpenAPI URL via `/{server}` endpoint
2. **Automatic Conversion**: MyMCP fetches and parses the OpenAPI specification
3. **Tool Generation**: Each API endpoint becomes an MCP tool with proper schemas
4. **Invoke & Stream**: Use standard MCP protocols to invoke tools or stream results

```
OpenAPI Spec → MyMCP → MCP Server → Your Application
```

---

## 🚀 Getting Started

### Prerequisites

- [Bun](https://bun.sh/) or Node.js 18+
- Cloudflare Workers account (for deployment)
- OpenAPI 3.x specification URL

### Installation

```bash
# Clone the repository
git clone https://github.com/gmitch215/MyMCP.git
cd MyMCP

# Install dependencies
bun install

# Run development server
bun run dev
```

---

## 📖 Usage

### MCP Protocol (Recommended)

MyMCP now supports the official Model Context Protocol! This means you can connect it directly to Claude Desktop, Cursor, Windsurf, and other MCP-compatible clients.

#### Quick Start with MCP Inspector

```bash
# Start the inspector
npx @modelcontextprotocol/inspector

# Connect to your server
# URL: http://localhost:8787/tabroom/sse
# or: https://mymcp.gmitch215.xyz/tabroom/sse
```

#### Configure with Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
	"mcpServers": {
		"tabroom-api": {
			"command": "npx",
			"args": ["mcp-remote", "https://mymcp.gmitch215.xyz/tabroom/sse"]
		}
	}
}
```

For detailed MCP protocol documentation, see [MCP_PROTOCOL.md](./MCP_PROTOCOL.md).

### Legacy API Usage

### Quick Start

1. **Access a server** via `/{server}` where `server` is either:
   - A pre-configured alias (e.g., `tabroom`)
   - A full HTTPS URL to an OpenAPI spec

2. **Explore available endpoints**:
   - `GET /{server}` - Server description
   - `GET /{server}/models` - List available models
   - `GET /{server}/tools` - List available tools
   - `GET /{server}/sse` - MCP SSE endpoint (recommended)
   - `POST /{server}/sse/message` - MCP JSON-RPC endpoint (recommended)
   - `POST /{server}/invoke` - Invoke a tool (legacy)
   - `POST /{server}/stream` - Create a streaming task (legacy)
   - `GET /{server}/stream/{id}` - Connect to WebSocket stream (legacy)

### Example: Using Pre-configured Server

```bash
# Get server description
curl https://mymcp.gmitch215.xyz/tabroom

# List available tools
curl https://mymcp.gmitch215.xyz/tabroom/tools

# Invoke a tool
curl -X POST https://mymcp.gmitch215.xyz/tabroom/invoke \
  -H "Content-Type: application/json" \
  -d '{
    "model": "api:tabroom:api.tabroom.com/v1",
    "tool": "getTournament",
    "parameters": {
      "path-id": "12345"
    }
  }'
```

### Example: Using Custom OpenAPI URL

```bash
# Access any OpenAPI spec
curl https://mymcp.gmitch215.xyz/https://api.example.com/openapi.json

# List tools from custom API
curl https://mymcp.gmitch215.xyz/https://api.example.com/openapi.json/tools
```

## 🔧 Pre-configured Servers

MyMCP comes with pre-configured aliases for common APIs. You can add more in `src/servers.json`.

### Adding New Servers

Edit `src/servers.json`:

```json
{
	"tabroom": "https://api.tabroom.com/v1/docs",
	"petstore": "https://petstore3.swagger.io/api/v3/openapi.json",
	"github": "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json"
}
```

---

## 🚢 Deployment

### Cloudflare Workers

1. **Install Wrangler CLI**:

   ```bash
   npm install -g wrangler
   ```

2. **Login to Cloudflare**:

   ```bash
   wrangler login
   ```

3. **Deploy**:

   ```bash
   bun run deploy
   # or
   wrangler deploy
   ```

### Environment Setup

No environment variables required! MyMCP works out of the box.

### Key Design Decisions

1. **Dynamic Tool Generation**: Tools are generated on-the-fly from OpenAPI specs, allowing any API to be used without code changes.

2. **Edge Deployment**: Cloudflare Workers ensures global low-latency access.

3. **Caching Strategy**: OpenAPI documents are cached for 1 hour to minimize external requests.

4. **Type Safety**: Full TypeScript implementation with comprehensive type definitions.

5. **Security**: HTTPS-only, CORS-enabled, with support for various authentication schemes.

6. **Observability**: Built-in metrics and detailed logging for monitoring.

---

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

---

## 📄 License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- Built with [Hono](https://hono.dev/) - Lightweight web framework
- Deployed on [Cloudflare Workers](https://workers.cloudflare.com/)
- Implements [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)
- OpenAPI specifications from various providers

---

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/gmitch215/MyMCP/issues)
- **Discussions**: [GitHub Discussions](https://github.com/gmitch215/MyMCP/discussions)

---

Made with ❤️ by [gmitch215](https://github.com/gmitch215)
