/**
 * User management tools for Nevent MCP
 */

import { NeventClient } from '../client/nevent-client.js';
import {
  User,
  UserCreateRequest,
  UserUpdateRequest,
  UserSearchParams,
  Page,
  PropertyDefinition,
  Purchase,
  EventSummary,
  CommunicationPreferences,
} from '../types/common.js';

/**
 * List users with optional filters and pagination
 */
export async function listUsers(
  client: NeventClient,
  params: UserSearchParams = {}
): Promise<Page<User>> {
  return client.get<Page<User>>('/users', {
    page: params.page ?? 0,
    size: params.size ?? 20,
    sort: params.sort,
    email: params.email,
    name: params.name,
    phone: params.phone,
    createdFrom: params.createdFrom,
    createdTo: params.createdTo,
    eventId: params.eventId,
    listId: params.listId,
  });
}

/**
 * Get a user by ID
 */
export async function getUser(
  client: NeventClient,
  userId: string
): Promise<User> {
  return client.get<User>(`/users/${userId}`);
}

/**
 * Get a user by email
 */
export async function getUserByEmail(
  client: NeventClient,
  email: string
): Promise<User> {
  return client.get<User>(`/users/email/${encodeURIComponent(email)}`);
}

/**
 * Create a new user
 */
export async function createUser(
  client: NeventClient,
  userData: UserCreateRequest
): Promise<User> {
  return client.post<User>('/users', userData);
}

/**
 * Update an existing user
 */
export async function updateUser(
  client: NeventClient,
  userId: string,
  userData: UserUpdateRequest
): Promise<User> {
  return client.put<User>(`/users/${userId}`, userData);
}

/**
 * Delete a user
 */
export async function deleteUser(
  client: NeventClient,
  userId: string
): Promise<void> {
  return client.delete<void>(`/users/${userId}`);
}

/**
 * Get user's purchase history
 */
export async function getUserPurchases(
  client: NeventClient,
  userId: string,
  params: { page?: number; size?: number } = {}
): Promise<Page<Purchase>> {
  return client.get<Page<Purchase>>(`/users/${userId}/purchases`, {
    page: params.page ?? 0,
    size: params.size ?? 20,
  });
}

/**
 * Get user's events (attended or purchased)
 */
export async function getUserEvents(
  client: NeventClient,
  userId: string,
  params: { page?: number; size?: number; type?: 'purchased' | 'attended' } = {}
): Promise<Page<EventSummary>> {
  return client.get<Page<EventSummary>>(`/users/${userId}/events`, {
    page: params.page ?? 0,
    size: params.size ?? 20,
    type: params.type,
  });
}

/**
 * Get custom property definitions for the tenant
 */
export async function getPropertyDefinitions(
  client: NeventClient,
  params: { type?: 'STANDARD' | 'CUSTOM' } = {}
): Promise<PropertyDefinition[]> {
  return client.get<PropertyDefinition[]>('/properties', {
    type: params.type,
  });
}

/**
 * Create a custom property definition
 */
export async function createPropertyDefinition(
  client: NeventClient,
  property: Omit<PropertyDefinition, 'id' | 'tenantId'>
): Promise<PropertyDefinition> {
  return client.post<PropertyDefinition>('/properties', property);
}

/**
 * Update a property definition
 */
export async function updatePropertyDefinition(
  client: NeventClient,
  propertyId: string,
  property: Partial<PropertyDefinition>
): Promise<PropertyDefinition> {
  return client.put<PropertyDefinition>(`/properties/${propertyId}`, property);
}

/**
 * Delete a property definition
 */
export async function deletePropertyDefinition(
  client: NeventClient,
  propertyId: string
): Promise<void> {
  return client.delete<void>(`/properties/${propertyId}`);
}

/**
 * Get user's communication preferences
 */
export async function getUserCommunicationPreferences(
  client: NeventClient,
  userId: string
): Promise<CommunicationPreferences> {
  return client.get<CommunicationPreferences>(`/users/${userId}/communication-preferences`);
}

/**
 * Update user's communication preferences
 */
export async function updateUserCommunicationPreferences(
  client: NeventClient,
  userId: string,
  preferences: CommunicationPreferences
): Promise<CommunicationPreferences> {
  return client.put<CommunicationPreferences>(
    `/users/${userId}/communication-preferences`,
    preferences
  );
}

/**
 * Search users by segment/list criteria
 */
export async function searchUsersBySegment(
  client: NeventClient,
  segmentId: string,
  params: { page?: number; size?: number } = {}
): Promise<Page<User>> {
  return client.get<Page<User>>(`/segments/${segmentId}/users`, {
    page: params.page ?? 0,
    size: params.size ?? 20,
  });
}

/**
 * Add user to a list/segment manually
 */
export async function addUserToList(
  client: NeventClient,
  listId: string,
  userId: string
): Promise<void> {
  return client.post<void>(`/lists/${listId}/users/${userId}`);
}

/**
 * Remove user from a list
 */
export async function removeUserFromList(
  client: NeventClient,
  listId: string,
  userId: string
): Promise<void> {
  return client.delete<void>(`/lists/${listId}/users/${userId}`);
}

/**
 * Get user count for tenant
 */
export async function getUserCount(
  client: NeventClient
): Promise<{ count: number }> {
  return client.get<{ count: number }>('/users/count');
}

/**
 * Export users to CSV
 */
export async function exportUsers(
  client: NeventClient,
  params: {
    format?: 'csv' | 'xlsx';
    fields?: string[];
    listId?: string;
    eventId?: string;
  } = {}
): Promise<{ downloadUrl: string }> {
  return client.post<{ downloadUrl: string }>('/users/export', params);
}

// Tool definitions for MCP
export const userToolDefinitions = [
  {
    name: 'list_users',
    description: 'List users with optional filters and pagination. Can filter by email, name, phone, date range, event, or list.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        page: { type: 'number', description: 'Page number (0-based)', default: 0 },
        size: { type: 'number', description: 'Page size', default: 20 },
        sort: { type: 'string', description: 'Sort field and direction (e.g., "createdAt,desc")' },
        email: { type: 'string', description: 'Filter by email (partial match)' },
        name: { type: 'string', description: 'Filter by name (partial match)' },
        phone: { type: 'string', description: 'Filter by phone number' },
        createdFrom: { type: 'string', description: 'Filter by creation date from (ISO format)' },
        createdTo: { type: 'string', description: 'Filter by creation date to (ISO format)' },
        eventId: { type: 'string', description: 'Filter by users who attended an event' },
        listId: { type: 'string', description: 'Filter by users in a specific list' },
      },
    },
  },
  {
    name: 'get_user',
    description: 'Get detailed information about a specific user by ID',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userId: { type: 'string', description: 'User ID' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'get_user_by_email',
    description: 'Get a user by their email address',
    inputSchema: {
      type: 'object' as const,
      properties: {
        email: { type: 'string', description: 'User email address' },
      },
      required: ['email'],
    },
  },
  {
    name: 'create_user',
    description: 'Create a new user in the system',
    inputSchema: {
      type: 'object' as const,
      properties: {
        email: { type: 'string', description: 'User email (required)' },
        name: { type: 'string', description: 'First name' },
        surname: { type: 'string', description: 'Last name' },
        phone: { type: 'string', description: 'Phone number' },
        birthDate: { type: 'string', description: 'Birth date (ISO format)' },
        gender: { type: 'string', description: 'Gender' },
        language: { type: 'string', description: 'Preferred language code' },
        country: { type: 'string', description: 'Country' },
        city: { type: 'string', description: 'City' },
        address: { type: 'string', description: 'Address' },
        postalCode: { type: 'string', description: 'Postal code' },
      },
      required: ['email'],
    },
  },
  {
    name: 'update_user',
    description: 'Update an existing user\'s information',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userId: { type: 'string', description: 'User ID' },
        name: { type: 'string', description: 'First name' },
        surname: { type: 'string', description: 'Last name' },
        phone: { type: 'string', description: 'Phone number' },
        birthDate: { type: 'string', description: 'Birth date (ISO format)' },
        gender: { type: 'string', description: 'Gender' },
        language: { type: 'string', description: 'Preferred language code' },
        country: { type: 'string', description: 'Country' },
        city: { type: 'string', description: 'City' },
        address: { type: 'string', description: 'Address' },
        postalCode: { type: 'string', description: 'Postal code' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'delete_user',
    description: 'Delete a user from the system',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userId: { type: 'string', description: 'User ID to delete' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'get_user_purchases',
    description: 'Get purchase history for a specific user',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userId: { type: 'string', description: 'User ID' },
        page: { type: 'number', description: 'Page number (0-based)', default: 0 },
        size: { type: 'number', description: 'Page size', default: 20 },
      },
      required: ['userId'],
    },
  },
  {
    name: 'get_user_events',
    description: 'Get events that a user has purchased tickets for or attended',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userId: { type: 'string', description: 'User ID' },
        page: { type: 'number', description: 'Page number (0-based)', default: 0 },
        size: { type: 'number', description: 'Page size', default: 20 },
        type: { type: 'string', enum: ['purchased', 'attended'], description: 'Filter by type' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'get_property_definitions',
    description: 'Get custom property definitions for users in the tenant',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', enum: ['STANDARD', 'CUSTOM'], description: 'Filter by property type' },
      },
    },
  },
  {
    name: 'create_property_definition',
    description: 'Create a new custom property definition for users',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Property internal name' },
        displayName: { type: 'string', description: 'Display name for UI' },
        dataType: { type: 'string', enum: ['TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'LIST'], description: 'Data type' },
        required: { type: 'boolean', description: 'Whether the field is required' },
        defaultValue: { type: 'string', description: 'Default value' },
        listValues: { type: 'array', items: { type: 'string' }, description: 'Possible values for LIST type' },
      },
      required: ['name', 'dataType'],
    },
  },
  {
    name: 'get_user_communication_preferences',
    description: 'Get communication preferences for a user (email, push, SMS, WhatsApp)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userId: { type: 'string', description: 'User ID' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'update_user_communication_preferences',
    description: 'Update communication preferences for a user',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userId: { type: 'string', description: 'User ID' },
        emailEnabled: { type: 'boolean', description: 'Enable email communications' },
        pushEnabled: { type: 'boolean', description: 'Enable push notifications' },
        smsEnabled: { type: 'boolean', description: 'Enable SMS' },
        whatsappEnabled: { type: 'boolean', description: 'Enable WhatsApp' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'get_user_count',
    description: 'Get the total count of users for the current tenant',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'export_users',
    description: 'Export users to CSV or Excel file',
    inputSchema: {
      type: 'object' as const,
      properties: {
        format: { type: 'string', enum: ['csv', 'xlsx'], description: 'Export format', default: 'csv' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Fields to include in export' },
        listId: { type: 'string', description: 'Filter by list ID' },
        eventId: { type: 'string', description: 'Filter by event ID' },
      },
    },
  },
];
