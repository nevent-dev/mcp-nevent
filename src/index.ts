#!/usr/bin/env node

/**
 * MCP Server for Nevent API
 * Provides tools for managing users and campaigns in the Nevent platform
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { NeventClient } from './client/nevent-client.js';
import { userToolDefinitions } from './tools/users.js';
import * as userTools from './tools/users.js';
import { campaignToolDefinitions } from './tools/campaigns.js';
import * as campaignTools from './tools/campaigns.js';
import { lineupToolDefinitions } from './tools/lineup.js';
import * as lineupTools from './tools/lineup.js';

// Configuration from environment variables
const NEVENT_API_URL = process.env.NEVENT_API_URL || 'https://api.nevent.io';
const NEVENT_JWT_TOKEN = process.env.NEVENT_JWT_TOKEN || '';
const NEVENT_TENANT_ID = process.env.NEVENT_TENANT_ID;

if (!NEVENT_JWT_TOKEN) {
  console.error('Error: NEVENT_JWT_TOKEN environment variable is required');
  process.exit(1);
}

// Initialize the Nevent client
const client = new NeventClient({
  baseUrl: NEVENT_API_URL,
  jwtToken: NEVENT_JWT_TOKEN,
  tenantId: NEVENT_TENANT_ID,
});

// Create the MCP server
const server = new Server(
  {
    name: 'mcp-nevent',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Combine all tool definitions
const allToolDefinitions = [...userToolDefinitions, ...campaignToolDefinitions, ...lineupToolDefinitions];

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: allToolDefinitions,
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const toolArgs = (args || {}) as Record<string, unknown>;

  try {
    let result: unknown;

    // User tools
    switch (name) {
      case 'list_users':
        result = await userTools.listUsers(client, toolArgs as unknown as Parameters<typeof userTools.listUsers>[1]);
        break;

      case 'get_user':
        result = await userTools.getUser(client, toolArgs.userId as string);
        break;

      case 'get_user_by_email':
        result = await userTools.getUserByEmail(client, toolArgs.email as string);
        break;

      case 'create_user':
        result = await userTools.createUser(client, toolArgs as unknown as Parameters<typeof userTools.createUser>[1]);
        break;

      case 'update_user': {
        const userId = toolArgs.userId as string;
        const { userId: _, ...userData } = toolArgs;
        result = await userTools.updateUser(client, userId, userData as unknown as Parameters<typeof userTools.updateUser>[2]);
        break;
      }

      case 'delete_user':
        result = await userTools.deleteUser(client, toolArgs.userId as string);
        break;

      case 'get_user_purchases': {
        const userId = toolArgs.userId as string;
        result = await userTools.getUserPurchases(client, userId, {
          page: toolArgs.page as number | undefined,
          size: toolArgs.size as number | undefined,
        });
        break;
      }

      case 'get_user_events': {
        const userId = toolArgs.userId as string;
        result = await userTools.getUserEvents(client, userId, {
          page: toolArgs.page as number | undefined,
          size: toolArgs.size as number | undefined,
          type: toolArgs.type as 'purchased' | 'attended' | undefined,
        });
        break;
      }

      case 'get_property_definitions':
        result = await userTools.getPropertyDefinitions(client, toolArgs as unknown as Parameters<typeof userTools.getPropertyDefinitions>[1]);
        break;

      case 'create_property_definition':
        result = await userTools.createPropertyDefinition(client, toolArgs as unknown as Parameters<typeof userTools.createPropertyDefinition>[1]);
        break;

      case 'get_user_communication_preferences':
        result = await userTools.getUserCommunicationPreferences(client, toolArgs.userId as string);
        break;

      case 'update_user_communication_preferences': {
        const userId = toolArgs.userId as string;
        const { userId: _, ...preferences } = toolArgs;
        result = await userTools.updateUserCommunicationPreferences(client, userId, preferences as unknown as Parameters<typeof userTools.updateUserCommunicationPreferences>[2]);
        break;
      }

      case 'get_user_count':
        result = await userTools.getUserCount(client);
        break;

      case 'export_users':
        result = await userTools.exportUsers(client, toolArgs as unknown as Parameters<typeof userTools.exportUsers>[1]);
        break;

      // Campaign tools
      case 'list_campaigns':
        result = await campaignTools.listCampaigns(client, toolArgs as unknown as Parameters<typeof campaignTools.listCampaigns>[1]);
        break;

      case 'get_campaign':
        result = await campaignTools.getCampaign(client, toolArgs.campaignId as string);
        break;

      case 'create_campaign':
        result = await campaignTools.createCampaign(client, toolArgs as unknown as Parameters<typeof campaignTools.createCampaign>[1]);
        break;

      case 'update_campaign': {
        const campaignId = toolArgs.campaignId as string;
        const { campaignId: _, ...campaignData } = toolArgs;
        result = await campaignTools.updateCampaign(client, campaignId, campaignData as unknown as Parameters<typeof campaignTools.updateCampaign>[2]);
        break;
      }

      case 'delete_campaign':
        result = await campaignTools.deleteCampaign(client, toolArgs.campaignId as string);
        break;

      case 'send_campaign':
        result = await campaignTools.sendCampaign(client, toolArgs.campaignId as string);
        break;

      case 'schedule_campaign':
        result = await campaignTools.scheduleCampaign(client, toolArgs.campaignId as string, toolArgs.scheduledAt as string);
        break;

      case 'pause_campaign':
        result = await campaignTools.pauseCampaign(client, toolArgs.campaignId as string);
        break;

      case 'cancel_campaign':
        result = await campaignTools.cancelCampaign(client, toolArgs.campaignId as string);
        break;

      case 'get_campaign_metrics':
        result = await campaignTools.getCampaignMetrics(client, toolArgs.campaignId as string);
        break;

      case 'send_test_campaign':
        result = await campaignTools.sendTestCampaign(client, toolArgs.campaignId as string, toolArgs.testEmails as string[]);
        break;

      case 'duplicate_campaign':
        result = await campaignTools.duplicateCampaign(client, toolArgs.campaignId as string);
        break;

      case 'list_segments':
        result = await campaignTools.listSegments(client, toolArgs as unknown as Parameters<typeof campaignTools.listSegments>[1]);
        break;

      case 'get_segment':
        result = await campaignTools.getSegment(client, toolArgs.segmentId as string);
        break;

      case 'create_segment':
        result = await campaignTools.createSegment(client, toolArgs as unknown as Parameters<typeof campaignTools.createSegment>[1]);
        break;

      case 'update_segment': {
        const segmentId = toolArgs.segmentId as string;
        const { segmentId: _, ...segmentData } = toolArgs;
        result = await campaignTools.updateSegment(client, segmentId, segmentData as unknown as Partial<Parameters<typeof campaignTools.createSegment>[1]>);
        break;
      }

      case 'delete_segment':
        result = await campaignTools.deleteSegment(client, toolArgs.segmentId as string);
        break;

      case 'preview_segment':
        result = await campaignTools.previewSegment(client, toolArgs.criteria as unknown as Parameters<typeof campaignTools.previewSegment>[1]);
        break;

      case 'execute_segment':
        result = await campaignTools.executeSegment(client, toolArgs.segmentId as string);
        break;

      case 'list_email_templates':
        result = await campaignTools.listEmailTemplates(client, toolArgs as unknown as Parameters<typeof campaignTools.listEmailTemplates>[1]);
        break;

      case 'get_email_template':
        result = await campaignTools.getEmailTemplate(client, toolArgs.templateId as string);
        break;

      case 'create_email_template':
        result = await campaignTools.createEmailTemplate(client, toolArgs as unknown as Parameters<typeof campaignTools.createEmailTemplate>[1]);
        break;

      case 'update_email_template': {
        const templateId = toolArgs.templateId as string;
        const { templateId: _, ...templateData } = toolArgs;
        result = await campaignTools.updateEmailTemplate(client, templateId, templateData as unknown as Partial<Parameters<typeof campaignTools.createEmailTemplate>[1]>);
        break;
      }

      case 'delete_email_template':
        result = await campaignTools.deleteEmailTemplate(client, toolArgs.templateId as string);
        break;

      case 'render_email_template':
        result = await campaignTools.renderEmailTemplate(client, toolArgs.templateId as string);
        break;

      case 'generate_email_content': {
        const prompt = toolArgs.prompt as string;
        const { prompt: _, ...options } = toolArgs;
        result = await campaignTools.generateEmailContent(client, prompt, options as unknown as Parameters<typeof campaignTools.generateEmailContent>[2]);
        break;
      }

      // Lineup tools - Performers
      case 'create_performer':
        result = await lineupTools.createPerformer(client, toolArgs as unknown as Parameters<typeof lineupTools.createPerformer>[1]);
        break;

      case 'search_spotify':
        result = await lineupTools.searchSpotify(client, toolArgs.query as string, toolArgs.limit as number | undefined);
        break;

      case 'search_performers':
        result = await lineupTools.searchPerformers(client, toolArgs.query as string, toolArgs.limit as number | undefined);
        break;

      case 'link_performer_spotify': {
        const performerId = toolArgs.performerId as string;
        result = await lineupTools.linkPerformerSpotify(client, performerId, {
          spotifyId: toolArgs.spotifyId as string,
          overrideData: toolArgs.overrideData as boolean | undefined,
        });
        break;
      }

      case 'unlink_performer_from_master':
        result = await lineupTools.unlinkPerformerFromMaster(client, toolArgs.performerId as string);
        break;

      case 'update_performer': {
        const performerId = toolArgs.performerId as string;
        const { performerId: _, ...performerData } = toolArgs;
        result = await lineupTools.updatePerformer(client, performerId, performerData as unknown as Parameters<typeof lineupTools.updatePerformer>[2]);
        break;
      }

      case 'get_performer':
        result = await lineupTools.getPerformer(client, toolArgs.performerId as string, toolArgs.includeMaster as boolean | undefined);
        break;

      case 'list_performers':
        result = await lineupTools.listPerformers(client, {
          page: toolArgs.page as number | undefined,
          size: toolArgs.size as number | undefined,
          sort: toolArgs.sort as string | undefined,
        });
        break;

      case 'delete_performer':
        result = await lineupTools.deletePerformer(client, toolArgs.performerId as string);
        break;

      case 'create_performer_from_master':
        result = await lineupTools.createPerformerFromMaster(client, toolArgs.masterPerformerId as string);
        break;

      case 'get_performer_likes':
        result = await lineupTools.getPerformerLikes(client, toolArgs.performerId as string, {
          page: toolArgs.page as number | undefined,
          size: toolArgs.size as number | undefined,
        });
        break;

      // Lineup tools - Sessions
      case 'list_event_sessions':
        result = await lineupTools.listEventSessions(client, toolArgs.eventId as string, {
          date: toolArgs.date as string | undefined,
          stage: toolArgs.stage as string | undefined,
          isPublished: toolArgs.isPublished as boolean | undefined,
        });
        break;

      case 'create_session': {
        const eventId = toolArgs.eventId as string;
        const { eventId: _, ...sessionData } = toolArgs;
        result = await lineupTools.createSession(client, eventId, sessionData as unknown as Omit<Parameters<typeof lineupTools.createSession>[2], 'eventId'>);
        break;
      }

      case 'update_session': {
        const sessionId = toolArgs.sessionId as string;
        const { sessionId: _, ...sessionData } = toolArgs;
        result = await lineupTools.updateSession(client, sessionId, sessionData as unknown as Parameters<typeof lineupTools.updateSession>[2]);
        break;
      }

      case 'get_session':
        result = await lineupTools.getSession(client, toolArgs.sessionId as string);
        break;

      case 'delete_session':
        result = await lineupTools.deleteSession(client, toolArgs.sessionId as string);
        break;

      case 'add_performer_to_session':
        result = await lineupTools.addPerformerToSession(client, toolArgs.sessionId as string, {
          performerId: toolArgs.performerId as string,
          displayOrder: toolArgs.displayOrder as number | undefined,
          notes: toolArgs.notes as string | undefined,
        });
        break;

      case 'remove_performer_from_session':
        result = await lineupTools.removePerformerFromSession(client, toolArgs.sessionId as string, toolArgs.performerId as string);
        break;

      case 'reorder_session_performers':
        result = await lineupTools.reorderSessionPerformers(client, toolArgs.sessionId as string, toolArgs.newOrders as Record<string, number>);
        break;

      case 'publish_session':
        result = await lineupTools.publishSession(client, toolArgs.sessionId as string, toolArgs.isPublished as boolean);
        break;

      // Lineup tools - Lineup
      case 'get_public_lineup':
        result = await lineupTools.getPublicLineup(client, toolArgs.eventId as string);
        break;

      case 'get_admin_lineup':
        result = await lineupTools.getAdminLineup(client, toolArgs.eventId as string);
        break;

      // Lineup tools - Daily Lineup
      case 'create_or_update_daily_lineup':
        result = await lineupTools.createOrUpdateDailyLineup(client, toolArgs.eventId as string, {
          date: toolArgs.date as string,
          performerIds: toolArgs.performerIds as string[],
          displayOrder: toolArgs.displayOrder as number | undefined,
        });
        break;

      case 'get_all_daily_lineups':
        result = await lineupTools.getAllDailyLineups(client, toolArgs.eventId as string);
        break;

      case 'get_daily_lineup_by_date':
        result = await lineupTools.getDailyLineupByDate(client, toolArgs.eventId as string, toolArgs.date as string);
        break;

      case 'update_daily_lineup':
        result = await lineupTools.updateDailyLineup(client, toolArgs.eventId as string, toolArgs.date as string, {
          date: toolArgs.date as string,
          performerIds: toolArgs.performerIds as string[],
          displayOrder: toolArgs.displayOrder as number | undefined,
        });
        break;

      case 'publish_daily_lineup':
        result = await lineupTools.publishDailyLineup(client, toolArgs.eventId as string, toolArgs.date as string);
        break;

      case 'unpublish_daily_lineup':
        result = await lineupTools.unpublishDailyLineup(client, toolArgs.eventId as string, toolArgs.date as string);
        break;

      case 'delete_daily_lineup':
        result = await lineupTools.deleteDailyLineup(client, toolArgs.eventId as string, toolArgs.date as string);
        break;

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      content: [
        {
          type: 'text',
          text: `Error: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Nevent MCP server running on stdio');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
