/**
 * Common types for Nevent API
 */

// Pagination
export interface PageRequest {
  page?: number;
  size?: number;
  sort?: string;
}

export interface Page<T> {
  content: T[];
  totalElements: number;
  totalPages: number;
  size: number;
  number: number;
  first: boolean;
  last: boolean;
  empty: boolean;
}

// User types
export interface User {
  id: string;
  email: string;
  name?: string;
  surname?: string;
  phone?: string;
  birthDate?: string;
  gender?: string;
  language?: string;
  country?: string;
  city?: string;
  address?: string;
  postalCode?: string;
  profileImage?: string;
  role?: string;
  tenantId?: string;
  memberOf?: string[];
  customFieldValues?: CustomFieldValue[];
  communicationPreferences?: CommunicationPreferences;
  createdAt?: string;
  updatedAt?: string;
}

export interface CustomFieldValue {
  propertyDefinitionId: string;
  value: unknown;
}

export interface CommunicationPreferences {
  emailEnabled?: boolean;
  pushEnabled?: boolean;
  smsEnabled?: boolean;
  whatsappEnabled?: boolean;
}

export interface UserCreateRequest {
  email: string;
  name?: string;
  surname?: string;
  phone?: string;
  birthDate?: string;
  gender?: string;
  language?: string;
  country?: string;
  city?: string;
  address?: string;
  postalCode?: string;
  customFieldValues?: CustomFieldValue[];
}

export interface UserUpdateRequest {
  name?: string;
  surname?: string;
  phone?: string;
  birthDate?: string;
  gender?: string;
  language?: string;
  country?: string;
  city?: string;
  address?: string;
  postalCode?: string;
  customFieldValues?: CustomFieldValue[];
}

export interface UserSearchParams extends PageRequest {
  email?: string;
  name?: string;
  phone?: string;
  createdFrom?: string;
  createdTo?: string;
  eventId?: string;
  listId?: string;
}

// Property Definition types
export interface PropertyDefinition {
  id: string;
  name: string;
  displayName?: string;
  dataType: 'TEXT' | 'NUMBER' | 'DATE' | 'BOOLEAN' | 'LIST';
  propertyType: 'STANDARD' | 'CUSTOM';
  tenantId?: string;
  required?: boolean;
  defaultValue?: unknown;
  listValues?: string[];
  validators?: PropertyValidator[];
}

export interface PropertyValidator {
  type: string;
  value?: unknown;
  message?: string;
}

// Campaign types
export interface Campaign {
  id: string;
  name: string;
  subject?: string;
  content?: string;
  type: 'EMAIL' | 'PUSH' | 'SMS' | 'WHATSAPP';
  status: 'DRAFT' | 'SCHEDULED' | 'SENDING' | 'SENT' | 'PAUSED' | 'CANCELLED';
  tenantId: string;
  listId?: string;
  segmentId?: string;
  templateId?: string;
  scheduledAt?: string;
  sentAt?: string;
  metrics?: CampaignMetrics;
  createdAt?: string;
  updatedAt?: string;
}

export interface CampaignMetrics {
  totalRecipients?: number;
  sent?: number;
  delivered?: number;
  opened?: number;
  clicked?: number;
  bounced?: number;
  complained?: number;
  unsubscribed?: number;
  openRate?: number;
  clickRate?: number;
}

export interface CampaignCreateRequest {
  name: string;
  subject?: string;
  content?: string;
  type: 'EMAIL' | 'PUSH' | 'SMS' | 'WHATSAPP';
  listId?: string;
  segmentId?: string;
  templateId?: string;
  scheduledAt?: string;
}

export interface CampaignUpdateRequest {
  name?: string;
  subject?: string;
  content?: string;
  listId?: string;
  segmentId?: string;
  templateId?: string;
  scheduledAt?: string;
}

// Segment types
export interface Segment {
  id: string;
  name: string;
  description?: string;
  tenantId: string;
  criteria?: SegmentCriteria;
  userCount?: number;
  lastExecutedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SegmentCriteria {
  stanzas: FilterStanza[];
  operator?: 'AND' | 'OR';
}

export interface FilterStanza {
  groups: FilterGroup[];
  operator?: 'AND' | 'OR';
}

export interface FilterGroup {
  field: string;
  operator: string;
  value: unknown;
}

export interface SegmentCreateRequest {
  name: string;
  description?: string;
  criteria: SegmentCriteria;
}

export interface SegmentPreview {
  userCount: number;
  sampleUsers?: User[];
}

// Email Template types
export interface EmailTemplate {
  id: string;
  name: string;
  subject?: string;
  mjmlContent?: string;
  htmlContent?: string;
  tenantId: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface EmailTemplateCreateRequest {
  name: string;
  subject?: string;
  mjmlContent?: string;
}

// Purchase types (for user history)
export interface Purchase {
  id: string;
  userId: string;
  eventId?: string;
  totalPrice: number;
  currency: string;
  status: string;
  paymentMethod?: string;
  purchasedAt: string;
  tickets?: TicketSummary[];
}

export interface TicketSummary {
  id: string;
  ticketTypeName: string;
  price: number;
  status: string;
}

// Event types (for user history)
export interface EventSummary {
  id: string;
  name: string;
  date?: string;
  venueName?: string;
  city?: string;
}

// Newsletter types
export interface Newsletter {
  id: string;
  name: string;
  description?: string;
  tenantId: string;
  fieldDefinitions?: NewsletterField[];
  subscriberCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface NewsletterField {
  name: string;
  type: string;
  required?: boolean;
}

export interface NewsletterSubscriber {
  id: string;
  email: string;
  newsletterId: string;
  status: 'PENDING' | 'CONFIRMED' | 'UNSUBSCRIBED';
  customFields?: Record<string, unknown>;
  subscribedAt?: string;
}

// Tenant types
export interface Tenant {
  id: string;
  name: string;
  slug?: string;
  domain?: string;
  email?: string;
  logo?: string;
  active?: boolean;
}

// Import types
export interface ImportResult {
  totalRows: number;
  successCount: number;
  errorCount: number;
  errors?: ImportError[];
}

export interface ImportError {
  row: number;
  field?: string;
  message: string;
}

// Lineup types

// Performer types
export interface PerformerImage {
  url: string;
  width?: number;
  height?: number;
  isPrimary?: boolean;
}

export interface SpotifyFollowers {
  total: number;
}

export interface Performer {
  id: string;
  tenantId: string;
  masterPerformerId?: string;
  spotifyId?: string;
  name: string;
  description?: string;
  image?: string;
  style?: string;
  tags: string[];
  socialLinks?: Record<string, string>;
  popularity?: number;
  spotifyUrl?: string;
  genres?: string[];
  images: PerformerImage[];
  followers?: SpotifyFollowers;
  source: 'SPOTIFY' | 'MANUAL' | 'LOCAL' | 'MASTER';
  createdAt?: string;
  updatedAt?: string;
  createdBy?: string;
  updatedBy?: string;
}

export interface CreatePerformerRequest {
  name: string;
  description?: string;
  style?: string;
  tags?: string[];
  images?: PerformerImage[];
  socialLinks?: Record<string, string>;
}

export interface UpdatePerformerRequest {
  name?: string;
  description?: string;
  style?: string;
  tags?: string[];
  images?: PerformerImage[];
  socialLinks?: Record<string, string>;
}

export interface LinkSpotifyRequest {
  spotifyId: string;
  overrideData?: boolean;
}

export interface UnifiedSearchResult {
  performers: Performer[];
  totalLocal: number;
  totalMaster: number;
  totalSpotify: number;
}

export interface UserLikeDTO {
  id: string;
  email?: string;
  name?: string;
  surname?: string;
  phone?: string;
  createdAt?: string;
}

// Session types
export interface Session {
  id: string;
  tenantId: string;
  eventId: string;
  name: string;
  startDateTime?: string;
  endDateTime?: string;
  displayOrder?: number;
  notes?: string;
  performerIds: string[];
  isPublished: boolean;
  createdAt?: string;
  updatedAt?: string;
  createdBy?: string;
  updatedBy?: string;
}

export interface PerformerInSession {
  performer: Performer;
  displayOrder?: number;
  notes?: string;
  likeCount?: number;
}

export interface SessionResponse {
  id: string;
  tenantId: string;
  eventId: string;
  name: string;
  startDateTime?: string;
  endDateTime?: string;
  displayOrder?: number;
  notes?: string;
  isPublished: boolean;
  performers: PerformerInSession[];
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateSessionRequest {
  eventId: string;
  name: string;
  startDateTime: string;
  endDateTime: string;
  performerIds?: string[];
  displayOrder?: number;
  notes?: string;
  isPublished?: boolean;
}

export interface UpdateSessionRequest {
  name?: string;
  startDateTime?: string;
  endDateTime?: string;
  displayOrder?: number;
  notes?: string;
  isPublished?: boolean;
}

export interface AddPerformerToSessionRequest {
  performerId: string;
  displayOrder?: number;
  notes?: string;
}

export interface SessionPerformer {
  id: string;
  sessionId: string;
  performerId: string;
  displayOrder: number;
  notes?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface PublishSessionRequest {
  isPublished: boolean;
}

// Lineup Response types
export interface LineupResponse {
  eventId: string;
  eventName: string;
  days: LineupDayResponse[];
}

export interface LineupDayResponse {
  date: string;
  stages: LineupStageResponse[];
}

export interface LineupStageResponse {
  stage: string;
  sessions: SessionResponse[];
}

// DailyLineup types
export type LineupStatus = 'DRAFT' | 'PUBLISHED';

export interface DailyLineupDTO {
  date: string;
  performers: Performer[];
  displayOrder?: number;
  status: LineupStatus;
  publishedAt?: string;
  publishedBy?: string;
}

export interface DailyLineupRequest {
  date: string;
  performerIds: string[];
  displayOrder?: number;
}
