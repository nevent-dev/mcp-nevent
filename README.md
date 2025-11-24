# MCP Server for Nevent API

A Model Context Protocol (MCP) server that provides tools for managing users and marketing campaigns in the Nevent platform.

## Features

### User Management (14 tools)
- List, search, and filter users
- Create, update, and delete users
- View user purchase history and events
- Manage custom property definitions
- Handle communication preferences
- Export users to CSV/Excel

### Campaign Management (25 tools)
- Create and manage email, push, SMS, and WhatsApp campaigns
- Schedule, send, pause, and cancel campaigns
- View campaign metrics (opens, clicks, bounces)
- Create and manage user segments for targeting
- Email templates with MJML support
- AI-powered email content generation

## Installation

```bash
npm install
npm run build
```

## Configuration

The server requires the following environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `NEVENT_JWT_TOKEN` | Yes | JWT token for API authentication |
| `NEVENT_API_URL` | No | API base URL (default: https://api.nevent.io) |
| `NEVENT_TENANT_ID` | No | Default tenant ID for multi-tenant operations |

### Getting a JWT Token

1. Log in to the Nevent admin panel
2. Navigate to Settings > API Access
3. Generate a new API token with the required permissions

## Usage with Claude Desktop

Add to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "nevent": {
      "command": "node",
      "args": ["/path/to/mcp-nevent/dist/index.js"],
      "env": {
        "NEVENT_JWT_TOKEN": "your-jwt-token-here",
        "NEVENT_TENANT_ID": "your-tenant-id"
      }
    }
  }
}
```

## Usage with Claude Code

```bash
claude mcp add nevent node /path/to/mcp-nevent/dist/index.js \
  -e NEVENT_JWT_TOKEN=your-token \
  -e NEVENT_TENANT_ID=your-tenant-id
```

## Available Tools

### User Tools

| Tool | Description |
|------|-------------|
| `list_users` | List users with filters and pagination |
| `get_user` | Get user by ID |
| `get_user_by_email` | Get user by email address |
| `create_user` | Create a new user |
| `update_user` | Update user information |
| `delete_user` | Delete a user |
| `get_user_purchases` | Get user's purchase history |
| `get_user_events` | Get user's events |
| `get_property_definitions` | Get custom property definitions |
| `create_property_definition` | Create custom property |
| `get_user_communication_preferences` | Get user preferences |
| `update_user_communication_preferences` | Update preferences |
| `get_user_count` | Get total user count |
| `export_users` | Export users to file |

### Campaign Tools

| Tool | Description |
|------|-------------|
| `list_campaigns` | List campaigns with filters |
| `get_campaign` | Get campaign details |
| `create_campaign` | Create new campaign |
| `update_campaign` | Update campaign |
| `delete_campaign` | Delete campaign |
| `send_campaign` | Send immediately |
| `schedule_campaign` | Schedule for later |
| `pause_campaign` | Pause sending |
| `cancel_campaign` | Cancel campaign |
| `get_campaign_metrics` | Get performance metrics |
| `send_test_campaign` | Send test email |
| `duplicate_campaign` | Duplicate campaign |

### Segment Tools

| Tool | Description |
|------|-------------|
| `list_segments` | List segments |
| `get_segment` | Get segment details |
| `create_segment` | Create segment |
| `update_segment` | Update segment |
| `delete_segment` | Delete segment |
| `preview_segment` | Preview user count |
| `execute_segment` | Refresh segment |

### Template Tools

| Tool | Description |
|------|-------------|
| `list_email_templates` | List templates |
| `get_email_template` | Get template |
| `create_email_template` | Create template |
| `update_email_template` | Update template |
| `delete_email_template` | Delete template |
| `render_email_template` | Render MJML to HTML |
| `generate_email_content` | AI content generation |

## Examples

### List users from a specific event
```
Use list_users with eventId="event123" to get all users who purchased tickets
```

### Create an email campaign
```
1. Create a segment with criteria for targeting
2. Create an email template with MJML
3. Create a campaign using the segment and template
4. Send a test email
5. Schedule or send the campaign
```

### Generate AI content
```
Use generate_email_content with:
- prompt: "Promotional email for summer festival early bird tickets"
- tone: "exciting"
- length: "medium"
- language: "es"
```

## Multi-Tenant Support

The server supports multi-tenant operations. You can:

1. Set a default tenant via `NEVENT_TENANT_ID` environment variable
2. The server uses this tenant for all API calls

For admin users, the tenant is determined by the JWT token. For superadmin users who need to switch between tenants, additional configuration may be needed.

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Run production build
npm start
```

## License

MIT
