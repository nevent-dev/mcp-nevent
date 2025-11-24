/**
 * Lineup management tools for Nevent MCP
 * Includes Performers, Sessions, and Lineup endpoints
 */

import { NeventClient } from '../client/nevent-client.js';
import {
  Performer,
  CreatePerformerRequest,
  UpdatePerformerRequest,
  LinkSpotifyRequest,
  UnifiedSearchResult,
  UserLikeDTO,
  Session,
  SessionResponse,
  CreateSessionRequest,
  UpdateSessionRequest,
  AddPerformerToSessionRequest,
  SessionPerformer,
  PublishSessionRequest,
  LineupResponse,
  DailyLineupDTO,
  DailyLineupRequest,
  Page,
} from '../types/common.js';

// ==================== PERFORMER FUNCTIONS ====================

/**
 * Create a performer manually
 */
export async function createPerformer(
  client: NeventClient,
  data: CreatePerformerRequest
): Promise<Performer> {
  return client.post<Performer>('/admin/performers', data);
}

/**
 * Search artists on Spotify
 */
export async function searchSpotify(
  client: NeventClient,
  query: string,
  limit: number = 10
): Promise<Performer[]> {
  return client.get<Performer[]>('/admin/performers/spotify/search', {
    query,
    limit,
  });
}

/**
 * Unified search for performers (local, master catalog, and Spotify)
 */
export async function searchPerformers(
  client: NeventClient,
  query: string,
  limit: number = 10
): Promise<UnifiedSearchResult> {
  return client.get<UnifiedSearchResult>('/admin/performers/search', {
    query,
    limit,
  });
}

/**
 * Link performer with Spotify
 */
export async function linkPerformerSpotify(
  client: NeventClient,
  performerId: string,
  data: LinkSpotifyRequest
): Promise<Performer> {
  return client.post<Performer>(`/admin/performers/${performerId}/link-spotify`, data);
}

/**
 * Unlink performer from master catalog
 */
export async function unlinkPerformerFromMaster(
  client: NeventClient,
  performerId: string
): Promise<Performer> {
  return client.post<Performer>(`/admin/performers/${performerId}/unlink-master`);
}

/**
 * Update a performer
 */
export async function updatePerformer(
  client: NeventClient,
  performerId: string,
  data: UpdatePerformerRequest
): Promise<Performer> {
  return client.patch<Performer>(`/admin/performers/${performerId}`, data);
}

/**
 * Get performer by ID
 */
export async function getPerformer(
  client: NeventClient,
  performerId: string,
  includeMaster: boolean = false
): Promise<Performer> {
  return client.get<Performer>(`/admin/performers/${performerId}`, {
    includeMaster,
  });
}

/**
 * List all performers for tenant
 */
export async function listPerformers(
  client: NeventClient,
  params: { page?: number; size?: number; sort?: string } = {}
): Promise<Page<Performer>> {
  return client.get<Page<Performer>>('/admin/performers', {
    page: params.page ?? 0,
    size: params.size ?? 20,
    sort: params.sort,
  });
}

/**
 * Delete a performer
 */
export async function deletePerformer(
  client: NeventClient,
  performerId: string
): Promise<void> {
  return client.delete<void>(`/admin/performers/${performerId}`);
}

/**
 * Create performer from master catalog
 */
export async function createPerformerFromMaster(
  client: NeventClient,
  masterPerformerId: string
): Promise<Performer> {
  return client.post<Performer>(`/admin/performers/from-master-performer/${masterPerformerId}`);
}

/**
 * Get users who liked a performer
 */
export async function getPerformerLikes(
  client: NeventClient,
  performerId: string,
  params: { page?: number; size?: number } = {}
): Promise<Page<UserLikeDTO>> {
  return client.get<Page<UserLikeDTO>>(`/admin/performers/${performerId}/likes`, {
    page: params.page ?? 0,
    size: params.size ?? 20,
  });
}

// ==================== SESSION FUNCTIONS ====================

/**
 * Get all sessions for an event
 */
export async function listEventSessions(
  client: NeventClient,
  eventId: string,
  params: { date?: string; stage?: string; isPublished?: boolean } = {}
): Promise<SessionResponse[]> {
  return client.get<SessionResponse[]>(`/admin/events/${eventId}/sessions`, {
    date: params.date,
    stage: params.stage,
    isPublished: params.isPublished,
  });
}

/**
 * Create a new session for an event
 */
export async function createSession(
  client: NeventClient,
  eventId: string,
  data: Omit<CreateSessionRequest, 'eventId'>
): Promise<Session> {
  return client.post<Session>(`/admin/events/${eventId}/sessions`, {
    ...data,
    eventId,
  });
}

/**
 * Update a session
 */
export async function updateSession(
  client: NeventClient,
  sessionId: string,
  data: UpdateSessionRequest
): Promise<Session> {
  return client.patch<Session>(`/admin/sessions/${sessionId}`, data);
}

/**
 * Get session by ID with performers
 */
export async function getSession(
  client: NeventClient,
  sessionId: string
): Promise<SessionResponse> {
  return client.get<SessionResponse>(`/admin/sessions/${sessionId}`);
}

/**
 * Delete a session
 */
export async function deleteSession(
  client: NeventClient,
  sessionId: string
): Promise<void> {
  return client.delete<void>(`/admin/sessions/${sessionId}`);
}

/**
 * Add performer to session
 */
export async function addPerformerToSession(
  client: NeventClient,
  sessionId: string,
  data: AddPerformerToSessionRequest
): Promise<SessionPerformer> {
  return client.post<SessionPerformer>(`/admin/sessions/${sessionId}/performers`, data);
}

/**
 * Remove performer from session
 */
export async function removePerformerFromSession(
  client: NeventClient,
  sessionId: string,
  performerId: string
): Promise<void> {
  return client.delete<void>(`/admin/sessions/${sessionId}/performers/${performerId}`);
}

/**
 * Reorder performers in session
 */
export async function reorderSessionPerformers(
  client: NeventClient,
  sessionId: string,
  newOrders: Record<string, number>
): Promise<void> {
  return client.put<void>(`/admin/sessions/${sessionId}/performers/reorder`, newOrders);
}

/**
 * Publish or unpublish a session
 */
export async function publishSession(
  client: NeventClient,
  sessionId: string,
  isPublished: boolean
): Promise<Session> {
  return client.patch<Session>(`/admin/sessions/${sessionId}/publish`, {
    isPublished,
  });
}

// ==================== LINEUP FUNCTIONS ====================

/**
 * Get public lineup for an event
 */
export async function getPublicLineup(
  client: NeventClient,
  eventId: string
): Promise<LineupResponse> {
  return client.get<LineupResponse>(`/public/events/${eventId}/lineup`);
}

/**
 * Get admin lineup for an event (includes unpublished sessions)
 */
export async function getAdminLineup(
  client: NeventClient,
  eventId: string
): Promise<LineupResponse> {
  return client.get<LineupResponse>(`/admin/events/${eventId}/lineup`);
}

// ==================== DAILY LINEUP FUNCTIONS ====================

/**
 * Create or update daily lineup
 */
export async function createOrUpdateDailyLineup(
  client: NeventClient,
  eventId: string,
  data: DailyLineupRequest
): Promise<DailyLineupDTO> {
  return client.post<DailyLineupDTO>(`/events/${eventId}/daily-lineup`, data);
}

/**
 * Get all daily lineups for an event
 */
export async function getAllDailyLineups(
  client: NeventClient,
  eventId: string
): Promise<DailyLineupDTO[]> {
  return client.get<DailyLineupDTO[]>(`/events/${eventId}/daily-lineup`);
}

/**
 * Get daily lineup by date
 */
export async function getDailyLineupByDate(
  client: NeventClient,
  eventId: string,
  date: string
): Promise<DailyLineupDTO> {
  return client.get<DailyLineupDTO>(`/events/${eventId}/daily-lineup/${date}`);
}

/**
 * Update daily lineup
 */
export async function updateDailyLineup(
  client: NeventClient,
  eventId: string,
  date: string,
  data: DailyLineupRequest
): Promise<DailyLineupDTO> {
  return client.put<DailyLineupDTO>(`/events/${eventId}/daily-lineup/${date}`, data);
}

/**
 * Publish daily lineup
 */
export async function publishDailyLineup(
  client: NeventClient,
  eventId: string,
  date: string
): Promise<DailyLineupDTO> {
  return client.put<DailyLineupDTO>(`/events/${eventId}/daily-lineup/${date}/publish`);
}

/**
 * Unpublish daily lineup
 */
export async function unpublishDailyLineup(
  client: NeventClient,
  eventId: string,
  date: string
): Promise<DailyLineupDTO> {
  return client.put<DailyLineupDTO>(`/events/${eventId}/daily-lineup/${date}/unpublish`);
}

/**
 * Delete daily lineup
 */
export async function deleteDailyLineup(
  client: NeventClient,
  eventId: string,
  date: string
): Promise<void> {
  return client.delete<void>(`/events/${eventId}/daily-lineup/${date}`);
}

// ==================== TOOL DEFINITIONS ====================

export const lineupToolDefinitions = [
  // Performer tools
  {
    name: 'create_performer',
    description: 'Create a new performer/artist manually without Spotify data. Requires name, can include description, style, tags, images, and social links.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Name of the performer (required)' },
        description: { type: 'string', description: 'Description or biography' },
        style: { type: 'string', description: 'Music style or genre (e.g., "Hip Hop", "Electronic")' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
        images: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              width: { type: 'number' },
              height: { type: 'number' },
              isPrimary: { type: 'boolean' },
            },
          },
          description: 'Images with resolution and primary flag',
        },
        socialLinks: {
          type: 'object',
          description: 'Social media links (e.g., {"instagram": "url", "tiktok": "url"})',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'search_spotify',
    description: 'Search for artists on Spotify. Returns artist data from Spotify API without creating performers in the database.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query (artist name)' },
        limit: { type: 'number', description: 'Maximum results (max: 50)', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_performers',
    description: 'Unified search across local performers, master catalog, and Spotify. Auto-creates Spotify artists in master catalog. Use existsInTenant to check if performer is already linked.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Maximum results (max: 50)', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'link_performer_spotify',
    description: 'Link an existing performer with Spotify data. Can enrich empty fields or overwrite all data.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        performerId: { type: 'string', description: 'Performer ID' },
        spotifyId: { type: 'string', description: 'Spotify artist ID' },
        overrideData: { type: 'boolean', description: 'If true, overwrite all data; if false, only enrich empty fields', default: false },
      },
      required: ['performerId', 'spotifyId'],
    },
  },
  {
    name: 'unlink_performer_from_master',
    description: 'Unlink a performer from the global master catalog. Local data is preserved.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        performerId: { type: 'string', description: 'Performer ID' },
      },
      required: ['performerId'],
    },
  },
  {
    name: 'update_performer',
    description: 'Update an existing performer. Only provided fields will be updated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        performerId: { type: 'string', description: 'Performer ID' },
        name: { type: 'string', description: 'Name' },
        description: { type: 'string', description: 'Description' },
        style: { type: 'string', description: 'Music style' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags' },
        images: { type: 'array', description: 'Images' },
        socialLinks: { type: 'object', description: 'Social media links' },
      },
      required: ['performerId'],
    },
  },
  {
    name: 'get_performer',
    description: 'Get a performer by ID. Optionally include master performer data.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        performerId: { type: 'string', description: 'Performer ID' },
        includeMaster: { type: 'boolean', description: 'Include master performer data', default: false },
      },
      required: ['performerId'],
    },
  },
  {
    name: 'list_performers',
    description: 'List all performers for the current tenant with pagination.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        page: { type: 'number', description: 'Page number (0-based)', default: 0 },
        size: { type: 'number', description: 'Page size', default: 20 },
        sort: { type: 'string', description: 'Sort field and direction (e.g., "name,asc")' },
      },
    },
  },
  {
    name: 'delete_performer',
    description: 'Delete a performer from the tenant.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        performerId: { type: 'string', description: 'Performer ID' },
      },
      required: ['performerId'],
    },
  },
  {
    name: 'create_performer_from_master',
    description: 'Create a tenant-specific performer from the global master catalog.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        masterPerformerId: { type: 'string', description: 'Master performer ID from catalog' },
      },
      required: ['masterPerformerId'],
    },
  },
  {
    name: 'get_performer_likes',
    description: 'Get users who liked a performer with pagination.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        performerId: { type: 'string', description: 'Performer ID' },
        page: { type: 'number', description: 'Page number (0-based)', default: 0 },
        size: { type: 'number', description: 'Page size', default: 20 },
      },
      required: ['performerId'],
    },
  },

  // Session tools
  {
    name: 'list_event_sessions',
    description: 'Get all sessions for an event with optional filters (date, stage, published status).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        eventId: { type: 'string', description: 'Event ID' },
        date: { type: 'string', description: 'Filter by date (YYYY-MM-DD)' },
        stage: { type: 'string', description: 'Filter by stage name' },
        isPublished: { type: 'boolean', description: 'Filter by published status' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'create_session',
    description: 'Create a new session for an event. A session groups performers at a specific time.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        eventId: { type: 'string', description: 'Event ID' },
        name: { type: 'string', description: 'Session name (e.g., "Friday Night - Main Stage")' },
        startDateTime: { type: 'string', description: 'Start date/time in ISO format' },
        endDateTime: { type: 'string', description: 'End date/time in ISO format' },
        performerIds: { type: 'array', items: { type: 'string' }, description: 'Initial performer IDs' },
        displayOrder: { type: 'number', description: 'Display order for sorting' },
        notes: { type: 'string', description: 'Additional notes' },
        isPublished: { type: 'boolean', description: 'Whether session is published', default: false },
      },
      required: ['eventId', 'name', 'startDateTime', 'endDateTime'],
    },
  },
  {
    name: 'update_session',
    description: 'Update an existing session. Only provided fields will be updated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
        name: { type: 'string', description: 'Session name' },
        startDateTime: { type: 'string', description: 'Start date/time' },
        endDateTime: { type: 'string', description: 'End date/time' },
        displayOrder: { type: 'number', description: 'Display order' },
        notes: { type: 'string', description: 'Notes' },
        isPublished: { type: 'boolean', description: 'Published status' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'get_session',
    description: 'Get a session by ID with all performers populated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'delete_session',
    description: 'Delete a session and all performer associations.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'add_performer_to_session',
    description: 'Add a performer to a session with optional display order and notes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
        performerId: { type: 'string', description: 'Performer ID' },
        displayOrder: { type: 'number', description: 'Display order within session' },
        notes: { type: 'string', description: 'Notes (e.g., "Special guest - DJ Set")' },
      },
      required: ['sessionId', 'performerId'],
    },
  },
  {
    name: 'remove_performer_from_session',
    description: 'Remove a performer from a session.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
        performerId: { type: 'string', description: 'Performer ID' },
      },
      required: ['sessionId', 'performerId'],
    },
  },
  {
    name: 'reorder_session_performers',
    description: 'Reorder performers within a session by providing a map of performerId to new display order.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
        newOrders: {
          type: 'object',
          description: 'Map of performer ID to new display order (e.g., {"id1": 1, "id2": 2})',
        },
      },
      required: ['sessionId', 'newOrders'],
    },
  },
  {
    name: 'publish_session',
    description: 'Publish or unpublish a session. Published sessions are visible to the public.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
        isPublished: { type: 'boolean', description: 'True to publish, false to unpublish' },
      },
      required: ['sessionId', 'isPublished'],
    },
  },

  // Lineup tools
  {
    name: 'get_public_lineup',
    description: 'Get the public lineup for an event. Only shows published sessions organized by date and stage.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        eventId: { type: 'string', description: 'Event ID' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'get_admin_lineup',
    description: 'Get the admin lineup for an event. Shows all sessions (published and unpublished).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        eventId: { type: 'string', description: 'Event ID' },
      },
      required: ['eventId'],
    },
  },

  // Daily Lineup tools
  {
    name: 'create_or_update_daily_lineup',
    description: 'Create or update the lineup for a specific day. Lineup is created in DRAFT status.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        eventId: { type: 'string', description: 'Event ID' },
        date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
        performerIds: { type: 'array', items: { type: 'string' }, description: 'Ordered list of performer IDs' },
        displayOrder: { type: 'number', description: 'Display order for the day' },
      },
      required: ['eventId', 'date', 'performerIds'],
    },
  },
  {
    name: 'get_all_daily_lineups',
    description: 'Get all daily lineups for an event (includes drafts for admins).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        eventId: { type: 'string', description: 'Event ID' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'get_daily_lineup_by_date',
    description: 'Get the lineup for a specific day.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        eventId: { type: 'string', description: 'Event ID' },
        date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
      },
      required: ['eventId', 'date'],
    },
  },
  {
    name: 'update_daily_lineup',
    description: 'Update the lineup for a specific day.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        eventId: { type: 'string', description: 'Event ID' },
        date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
        performerIds: { type: 'array', items: { type: 'string' }, description: 'Ordered list of performer IDs' },
        displayOrder: { type: 'number', description: 'Display order for the day' },
      },
      required: ['eventId', 'date', 'performerIds'],
    },
  },
  {
    name: 'publish_daily_lineup',
    description: 'Publish a daily lineup, making it visible on public endpoints.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        eventId: { type: 'string', description: 'Event ID' },
        date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
      },
      required: ['eventId', 'date'],
    },
  },
  {
    name: 'unpublish_daily_lineup',
    description: 'Unpublish a daily lineup, hiding it from public endpoints.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        eventId: { type: 'string', description: 'Event ID' },
        date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
      },
      required: ['eventId', 'date'],
    },
  },
  {
    name: 'delete_daily_lineup',
    description: 'Delete a daily lineup. Cannot delete published lineups (must unpublish first).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        eventId: { type: 'string', description: 'Event ID' },
        date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
      },
      required: ['eventId', 'date'],
    },
  },
];
