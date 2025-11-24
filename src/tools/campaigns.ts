/**
 * Campaign management tools for Nevent MCP
 */

import { NeventClient } from '../client/nevent-client.js';
import {
  Campaign,
  CampaignCreateRequest,
  CampaignUpdateRequest,
  CampaignMetrics,
  Segment,
  SegmentCreateRequest,
  SegmentPreview,
  SegmentCriteria,
  EmailTemplate,
  EmailTemplateCreateRequest,
  Page,
  PageRequest,
} from '../types/common.js';

// Campaign functions

/**
 * List campaigns with pagination
 */
export async function listCampaigns(
  client: NeventClient,
  params: PageRequest & {
    type?: 'EMAIL' | 'PUSH' | 'SMS' | 'WHATSAPP';
    status?: string;
  } = {}
): Promise<Page<Campaign>> {
  return client.get<Page<Campaign>>('/campaigns', {
    page: params.page ?? 0,
    size: params.size ?? 20,
    sort: params.sort,
    type: params.type,
    status: params.status,
  });
}

/**
 * Get a campaign by ID
 */
export async function getCampaign(
  client: NeventClient,
  campaignId: string
): Promise<Campaign> {
  return client.get<Campaign>(`/campaigns/${campaignId}`);
}

/**
 * Create a new campaign
 */
export async function createCampaign(
  client: NeventClient,
  campaign: CampaignCreateRequest
): Promise<Campaign> {
  return client.post<Campaign>('/campaigns', campaign);
}

/**
 * Update a campaign
 */
export async function updateCampaign(
  client: NeventClient,
  campaignId: string,
  campaign: CampaignUpdateRequest
): Promise<Campaign> {
  return client.put<Campaign>(`/campaigns/${campaignId}`, campaign);
}

/**
 * Delete a campaign
 */
export async function deleteCampaign(
  client: NeventClient,
  campaignId: string
): Promise<void> {
  return client.delete<void>(`/campaigns/${campaignId}`);
}

/**
 * Send a campaign immediately
 */
export async function sendCampaign(
  client: NeventClient,
  campaignId: string
): Promise<Campaign> {
  return client.post<Campaign>(`/campaigns/${campaignId}/send`);
}

/**
 * Schedule a campaign for later
 */
export async function scheduleCampaign(
  client: NeventClient,
  campaignId: string,
  scheduledAt: string
): Promise<Campaign> {
  return client.post<Campaign>(`/campaigns/${campaignId}/schedule`, { scheduledAt });
}

/**
 * Pause a campaign that is being sent
 */
export async function pauseCampaign(
  client: NeventClient,
  campaignId: string
): Promise<Campaign> {
  return client.post<Campaign>(`/campaigns/${campaignId}/pause`);
}

/**
 * Resume a paused campaign
 */
export async function resumeCampaign(
  client: NeventClient,
  campaignId: string
): Promise<Campaign> {
  return client.post<Campaign>(`/campaigns/${campaignId}/resume`);
}

/**
 * Cancel a scheduled or sending campaign
 */
export async function cancelCampaign(
  client: NeventClient,
  campaignId: string
): Promise<Campaign> {
  return client.post<Campaign>(`/campaigns/${campaignId}/cancel`);
}

/**
 * Get campaign metrics (opens, clicks, bounces, etc.)
 */
export async function getCampaignMetrics(
  client: NeventClient,
  campaignId: string
): Promise<CampaignMetrics> {
  return client.get<CampaignMetrics>(`/campaigns/${campaignId}/metrics`);
}

/**
 * Send a test email for a campaign
 */
export async function sendTestCampaign(
  client: NeventClient,
  campaignId: string,
  testEmails: string[]
): Promise<void> {
  return client.post<void>(`/campaigns/${campaignId}/test`, { emails: testEmails });
}

/**
 * Duplicate a campaign
 */
export async function duplicateCampaign(
  client: NeventClient,
  campaignId: string
): Promise<Campaign> {
  return client.post<Campaign>(`/campaigns/${campaignId}/duplicate`);
}

// Segment functions

/**
 * List segments
 */
export async function listSegments(
  client: NeventClient,
  params: PageRequest = {}
): Promise<Page<Segment>> {
  return client.get<Page<Segment>>('/segments', {
    page: params.page ?? 0,
    size: params.size ?? 20,
    sort: params.sort,
  });
}

/**
 * Get a segment by ID
 */
export async function getSegment(
  client: NeventClient,
  segmentId: string
): Promise<Segment> {
  return client.get<Segment>(`/segments/${segmentId}`);
}

/**
 * Create a new segment
 */
export async function createSegment(
  client: NeventClient,
  segment: SegmentCreateRequest
): Promise<Segment> {
  return client.post<Segment>('/segments', segment);
}

/**
 * Update a segment
 */
export async function updateSegment(
  client: NeventClient,
  segmentId: string,
  segment: Partial<SegmentCreateRequest>
): Promise<Segment> {
  return client.put<Segment>(`/segments/${segmentId}`, segment);
}

/**
 * Delete a segment
 */
export async function deleteSegment(
  client: NeventClient,
  segmentId: string
): Promise<void> {
  return client.delete<void>(`/segments/${segmentId}`);
}

/**
 * Preview segment results (count and sample users)
 */
export async function previewSegment(
  client: NeventClient,
  criteria: SegmentCriteria
): Promise<SegmentPreview> {
  return client.post<SegmentPreview>('/segments/preview', criteria);
}

/**
 * Execute segment and update user count
 */
export async function executeSegment(
  client: NeventClient,
  segmentId: string
): Promise<Segment> {
  return client.post<Segment>(`/segments/${segmentId}/execute`);
}

// Email Template functions

/**
 * List email templates
 */
export async function listEmailTemplates(
  client: NeventClient,
  params: PageRequest = {}
): Promise<Page<EmailTemplate>> {
  return client.get<Page<EmailTemplate>>('/templates/email', {
    page: params.page ?? 0,
    size: params.size ?? 20,
    sort: params.sort,
  });
}

/**
 * Get an email template by ID
 */
export async function getEmailTemplate(
  client: NeventClient,
  templateId: string
): Promise<EmailTemplate> {
  return client.get<EmailTemplate>(`/templates/email/${templateId}`);
}

/**
 * Create an email template
 */
export async function createEmailTemplate(
  client: NeventClient,
  template: EmailTemplateCreateRequest
): Promise<EmailTemplate> {
  return client.post<EmailTemplate>('/templates/email', template);
}

/**
 * Update an email template
 */
export async function updateEmailTemplate(
  client: NeventClient,
  templateId: string,
  template: Partial<EmailTemplateCreateRequest>
): Promise<EmailTemplate> {
  return client.put<EmailTemplate>(`/templates/email/${templateId}`, template);
}

/**
 * Delete an email template
 */
export async function deleteEmailTemplate(
  client: NeventClient,
  templateId: string
): Promise<void> {
  return client.delete<void>(`/templates/email/${templateId}`);
}

/**
 * Render email template to HTML (from MJML)
 */
export async function renderEmailTemplate(
  client: NeventClient,
  templateId: string
): Promise<{ html: string }> {
  return client.get<{ html: string }>(`/templates/email/${templateId}/render`);
}

/**
 * Generate email content using AI
 */
export async function generateEmailContent(
  client: NeventClient,
  prompt: string,
  options: {
    tone?: string;
    length?: 'short' | 'medium' | 'long';
    language?: string;
  } = {}
): Promise<{ subject: string; content: string }> {
  return client.post<{ subject: string; content: string }>('/campaigns/generate', {
    prompt,
    ...options,
  });
}

// Tool definitions for MCP
export const campaignToolDefinitions = [
  {
    name: 'list_campaigns',
    description: 'List marketing campaigns with pagination. Can filter by type (EMAIL, PUSH, SMS, WHATSAPP) and status.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        page: { type: 'number', description: 'Page number (0-based)', default: 0 },
        size: { type: 'number', description: 'Page size', default: 20 },
        sort: { type: 'string', description: 'Sort field and direction' },
        type: { type: 'string', enum: ['EMAIL', 'PUSH', 'SMS', 'WHATSAPP'], description: 'Campaign type filter' },
        status: { type: 'string', description: 'Status filter (DRAFT, SCHEDULED, SENDING, SENT, etc.)' },
      },
    },
  },
  {
    name: 'get_campaign',
    description: 'Get detailed information about a specific campaign',
    inputSchema: {
      type: 'object' as const,
      properties: {
        campaignId: { type: 'string', description: 'Campaign ID' },
      },
      required: ['campaignId'],
    },
  },
  {
    name: 'create_campaign',
    description: 'Create a new marketing campaign (email, push, SMS, or WhatsApp)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Campaign name' },
        type: { type: 'string', enum: ['EMAIL', 'PUSH', 'SMS', 'WHATSAPP'], description: 'Campaign type' },
        subject: { type: 'string', description: 'Email subject (for EMAIL type)' },
        content: { type: 'string', description: 'Campaign content/message' },
        segmentId: { type: 'string', description: 'Target segment ID' },
        templateId: { type: 'string', description: 'Email template ID (for EMAIL type)' },
        scheduledAt: { type: 'string', description: 'Schedule time (ISO format)' },
      },
      required: ['name', 'type'],
    },
  },
  {
    name: 'update_campaign',
    description: 'Update an existing campaign',
    inputSchema: {
      type: 'object' as const,
      properties: {
        campaignId: { type: 'string', description: 'Campaign ID' },
        name: { type: 'string', description: 'Campaign name' },
        subject: { type: 'string', description: 'Email subject' },
        content: { type: 'string', description: 'Campaign content' },
        segmentId: { type: 'string', description: 'Target segment ID' },
        templateId: { type: 'string', description: 'Email template ID' },
        scheduledAt: { type: 'string', description: 'Schedule time (ISO format)' },
      },
      required: ['campaignId'],
    },
  },
  {
    name: 'delete_campaign',
    description: 'Delete a campaign',
    inputSchema: {
      type: 'object' as const,
      properties: {
        campaignId: { type: 'string', description: 'Campaign ID to delete' },
      },
      required: ['campaignId'],
    },
  },
  {
    name: 'send_campaign',
    description: 'Send a campaign immediately to all recipients in the target segment',
    inputSchema: {
      type: 'object' as const,
      properties: {
        campaignId: { type: 'string', description: 'Campaign ID to send' },
      },
      required: ['campaignId'],
    },
  },
  {
    name: 'schedule_campaign',
    description: 'Schedule a campaign to be sent at a specific time',
    inputSchema: {
      type: 'object' as const,
      properties: {
        campaignId: { type: 'string', description: 'Campaign ID' },
        scheduledAt: { type: 'string', description: 'When to send (ISO format)' },
      },
      required: ['campaignId', 'scheduledAt'],
    },
  },
  {
    name: 'pause_campaign',
    description: 'Pause a campaign that is currently being sent',
    inputSchema: {
      type: 'object' as const,
      properties: {
        campaignId: { type: 'string', description: 'Campaign ID' },
      },
      required: ['campaignId'],
    },
  },
  {
    name: 'cancel_campaign',
    description: 'Cancel a scheduled or sending campaign',
    inputSchema: {
      type: 'object' as const,
      properties: {
        campaignId: { type: 'string', description: 'Campaign ID' },
      },
      required: ['campaignId'],
    },
  },
  {
    name: 'get_campaign_metrics',
    description: 'Get performance metrics for a campaign (opens, clicks, bounces, etc.)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        campaignId: { type: 'string', description: 'Campaign ID' },
      },
      required: ['campaignId'],
    },
  },
  {
    name: 'send_test_campaign',
    description: 'Send a test email of the campaign to specified email addresses',
    inputSchema: {
      type: 'object' as const,
      properties: {
        campaignId: { type: 'string', description: 'Campaign ID' },
        testEmails: { type: 'array', items: { type: 'string' }, description: 'Email addresses to send test to' },
      },
      required: ['campaignId', 'testEmails'],
    },
  },
  {
    name: 'duplicate_campaign',
    description: 'Create a copy of an existing campaign',
    inputSchema: {
      type: 'object' as const,
      properties: {
        campaignId: { type: 'string', description: 'Campaign ID to duplicate' },
      },
      required: ['campaignId'],
    },
  },
  {
    name: 'list_segments',
    description: 'List user segments for targeting campaigns',
    inputSchema: {
      type: 'object' as const,
      properties: {
        page: { type: 'number', description: 'Page number (0-based)', default: 0 },
        size: { type: 'number', description: 'Page size', default: 20 },
        sort: { type: 'string', description: 'Sort field and direction' },
      },
    },
  },
  {
    name: 'get_segment',
    description: 'Get detailed information about a segment including its criteria',
    inputSchema: {
      type: 'object' as const,
      properties: {
        segmentId: { type: 'string', description: 'Segment ID' },
      },
      required: ['segmentId'],
    },
  },
  {
    name: 'create_segment',
    description: 'Create a new user segment with filtering criteria',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Segment name' },
        description: { type: 'string', description: 'Segment description' },
        criteria: {
          type: 'object',
          description: 'Filtering criteria with stanzas and groups',
          properties: {
            stanzas: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  groups: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        field: { type: 'string' },
                        operator: { type: 'string' },
                        value: {},
                      },
                    },
                  },
                  operator: { type: 'string', enum: ['AND', 'OR'] },
                },
              },
            },
            operator: { type: 'string', enum: ['AND', 'OR'] },
          },
        },
      },
      required: ['name', 'criteria'],
    },
  },
  {
    name: 'update_segment',
    description: 'Update a segment\'s name, description, or criteria',
    inputSchema: {
      type: 'object' as const,
      properties: {
        segmentId: { type: 'string', description: 'Segment ID' },
        name: { type: 'string', description: 'Segment name' },
        description: { type: 'string', description: 'Segment description' },
        criteria: { type: 'object', description: 'Filtering criteria' },
      },
      required: ['segmentId'],
    },
  },
  {
    name: 'delete_segment',
    description: 'Delete a segment',
    inputSchema: {
      type: 'object' as const,
      properties: {
        segmentId: { type: 'string', description: 'Segment ID' },
      },
      required: ['segmentId'],
    },
  },
  {
    name: 'preview_segment',
    description: 'Preview how many users match segment criteria before saving',
    inputSchema: {
      type: 'object' as const,
      properties: {
        criteria: {
          type: 'object',
          description: 'Filtering criteria to preview',
        },
      },
      required: ['criteria'],
    },
  },
  {
    name: 'execute_segment',
    description: 'Execute segment query to update the user count',
    inputSchema: {
      type: 'object' as const,
      properties: {
        segmentId: { type: 'string', description: 'Segment ID' },
      },
      required: ['segmentId'],
    },
  },
  {
    name: 'list_email_templates',
    description: 'List available email templates',
    inputSchema: {
      type: 'object' as const,
      properties: {
        page: { type: 'number', description: 'Page number (0-based)', default: 0 },
        size: { type: 'number', description: 'Page size', default: 20 },
      },
    },
  },
  {
    name: 'get_email_template',
    description: 'Get an email template with its MJML content',
    inputSchema: {
      type: 'object' as const,
      properties: {
        templateId: { type: 'string', description: 'Template ID' },
      },
      required: ['templateId'],
    },
  },
  {
    name: 'create_email_template',
    description: 'Create a new email template using MJML',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Template name' },
        subject: { type: 'string', description: 'Default email subject' },
        mjmlContent: { type: 'string', description: 'MJML template content' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_email_template',
    description: 'Update an email template',
    inputSchema: {
      type: 'object' as const,
      properties: {
        templateId: { type: 'string', description: 'Template ID' },
        name: { type: 'string', description: 'Template name' },
        subject: { type: 'string', description: 'Default email subject' },
        mjmlContent: { type: 'string', description: 'MJML template content' },
      },
      required: ['templateId'],
    },
  },
  {
    name: 'delete_email_template',
    description: 'Delete an email template',
    inputSchema: {
      type: 'object' as const,
      properties: {
        templateId: { type: 'string', description: 'Template ID' },
      },
      required: ['templateId'],
    },
  },
  {
    name: 'render_email_template',
    description: 'Render an MJML email template to HTML',
    inputSchema: {
      type: 'object' as const,
      properties: {
        templateId: { type: 'string', description: 'Template ID' },
      },
      required: ['templateId'],
    },
  },
  {
    name: 'generate_email_content',
    description: 'Generate email subject and content using AI based on a prompt',
    inputSchema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: 'Description of what the email should be about' },
        tone: { type: 'string', description: 'Tone of the email (professional, casual, friendly, etc.)' },
        length: { type: 'string', enum: ['short', 'medium', 'long'], description: 'Desired length' },
        language: { type: 'string', description: 'Language code (es, en, etc.)' },
      },
      required: ['prompt'],
    },
  },
];
