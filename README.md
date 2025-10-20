# MyMCP - OpenAPI to MCP Server Converter

[![Deploy to Cloudflare Workers](https://img.shields.io/badge/Deploy%20to-Cloudflare%20Workers-orange)](https://workers.cloudflare.com/)

**MyMCP** is a powerful serverless application that dynamically converts any OpenAPI v3 specification into a fully-functional Model Context Protocol (MCP) server. Deploy it once, and instantly expose any OpenAPI-compliant API as an MCP-compatible interface with tools, streaming, and more.

🌐 **Live Instance**: [mymcp.gmitch215.xyz](https://mymcp.gmitch215.xyz)

---

## 📋 Table of Contents

- [How It Works](#-how-it-works)
- [Getting Started](#-getting-started)
- [Usage](#-usage)
- [Pre-configured Servers](#-pre-configured-servers)
- [Contributing](#-contributing)`
- [License](#-license)
- [Acknowledgements](#-acknowledgments)

---

## 🎯 How It Works

1. **Point to OpenAPI Spec**: Access any OpenAPI URL via `/{server}` endpoint
2. **Automatic Conversion**: MyMCP fetches and parses the OpenAPI specification
3. **Tool Generation**: Each API endpoint becomes an MCP tool with proper schemas
4. **Invoke & Stream**: Use standard MCP protocols to invoke tools or stream results

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

MyMCP supports the official Model Context Protocol specification (2024-11-05). This means you can connect it directly to Claude Desktop, Cursor, Windsurf, and other MCP-compatible clients.

### Supported MCP Methods

- ✅ `initialize` - Initialize connection with protocol version and capabilities
- ✅ `tools/list` - List all available API endpoints as tools
- ✅ `tools/call` - Execute API calls through the MCP interface
- ✅ `prompts/list` - Discover available prompts (auto-generated from endpoints)
- ✅ `resources/list` - List resources (empty, extensible for future use)
- ✅ `resources/templates/list` - List resource templates (empty, extensible)
- ✅ `notifications/initialized` - Client initialization notification
- ✅ `ping` - Connection health check

### 🔧 Pre-configured Servers

MyMCP comes with pre-configured aliases for common APIs. You can add more in `src/servers.json`.

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

This project is licensed under the MPL License. See the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- Built with [Hono](https://hono.dev/) - Lightweight web framework
- Deployed on [Cloudflare Workers](https://workers.cloudflare.com/)
- Implements [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)
- OpenAPI specifications from various providers

---

Made with ❤️ by [gmitch215](https://github.com/gmitch215)
