/**
 * Unipile API Client
 * Wrapper for Unipile REST API to interact with LinkedIn
 */

import { z } from 'zod';

// Environment configuration
const config = {
  apiKey: process.env.UNIPILE_API_KEY || '',
  dsn: process.env.UNIPILE_DSN || '',
  accountId: process.env.UNIPILE_ACCOUNT_ID || '',
};

// Base URL for API calls
function getBaseUrl(): string {
  return `https://${config.dsn}/api/v1`;
}

// Common headers for all requests
function getHeaders(): Record<string, string> {
  return {
    'X-API-KEY': config.apiKey,
    'Content-Type': 'application/json',
  };
}

// Error response schema
const ErrorResponseSchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
  status: z.number().optional(),
});

// Generic API request function
async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  endpoint: string,
  body?: unknown,
  additionalHeaders?: Record<string, string>
): Promise<T> {
  const url = `${getBaseUrl()}${endpoint}`;

  const response = await fetch(url, {
    method,
    headers: {
      ...getHeaders(),
      ...additionalHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const parsed = ErrorResponseSchema.safeParse(errorData);
    const errorMessage = parsed.success
      ? parsed.data.message || parsed.data.error || `HTTP ${response.status}`
      : `HTTP ${response.status}: ${response.statusText}`;

    throw new UnipileError(errorMessage, response.status, errorData);
  }

  return response.json() as Promise<T>;
}

// Custom error class
export class UnipileError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public data?: unknown
  ) {
    super(message);
    this.name = 'UnipileError';
  }
}

// ============ LinkedIn Search ============

export interface SearchParams {
  url?: string;  // Copy-pasted LinkedIn search URL
  keywords?: string;
  location?: string;
  industry?: string;
  company?: string;
  title?: string;
  connection_degree?: 1 | 2 | 3;
  cursor?: string;  // For pagination
  // Advanced filters
  category?: 'people' | 'companies' | 'jobs' | 'posts';
  api?: 'classic' | 'sales_navigator' | 'recruiter';
  tenure_min?: number;  // Years at company min
  tenure_max?: number;  // Years at company max
  company_size?: string[];  // e.g., ['B', 'C', 'D'] for 11-50, 51-200, 201-500
  network_distance?: number[];  // [1, 2, 3] for connection degrees
  profile_language?: string[];  // e.g., ['en', 'es']
  has_job_offers?: boolean;  // For company search
}

export interface SearchResult {
  id: string;
  provider_id: string;
  public_identifier: string;
  full_name: string;
  first_name?: string;
  last_name?: string;
  headline?: string;
  location?: string;
  profile_url: string;
  picture_url?: string;
  connection_degree?: number;
  current_company?: string;
  current_position?: string;
  // Company-specific fields
  industry?: string;
  employee_count?: number;
  website?: string;
  description?: string;
  // Job-specific fields
  company_name?: string;
  job_title?: string;
  posted_at?: string;
}

export interface SearchResponse {
  items: SearchResult[];
  cursor?: string;
  has_more: boolean;
}

export async function searchLinkedIn(
  accountId: string,
  params: SearchParams
): Promise<SearchResponse> {
  const body: Record<string, unknown> = {
    api: params.api || 'classic',
    category: params.category || 'people',
  };

  if (params.url) {
    body.url = params.url;
  } else {
    // Build keywords with location if not using URL
    let keywords = params.keywords || '';
    if (params.location && !params.category) {
      keywords += ` ${params.location}`;
    }
    if (params.title) {
      keywords += ` ${params.title}`;
    }
    if (params.company && params.category !== 'companies') {
      keywords += ` ${params.company}`;
    }
    if (keywords.trim()) {
      body.keywords = keywords.trim();
    }

    // Advanced filters
    if (params.tenure_min !== undefined || params.tenure_max !== undefined) {
      body.tenure = [{
        ...(params.tenure_min !== undefined && { min: params.tenure_min }),
        ...(params.tenure_max !== undefined && { max: params.tenure_max }),
      }];
    }

    if (params.company_size?.length) {
      body.company_headcount = params.company_size;
    }

    if (params.network_distance?.length) {
      body.network_distance = params.network_distance;
    }

    if (params.profile_language?.length) {
      body.profile_language = params.profile_language;
    }

    if (params.industry) {
      body.industry = { include: [params.industry] };
    }

    if (params.has_job_offers !== undefined) {
      body.has_job_offers = params.has_job_offers;
    }
  }

  if (params.cursor) {
    body.cursor = params.cursor;
  }

  // account_id goes in query string, not body
  const endpoint = `/linkedin/search?account_id=${encodeURIComponent(accountId)}`;

  const response = await apiRequest<{
    object: string;
    items: Array<{
      id: string;
      name: string;
      public_identifier?: string;
      profile_url?: string;
      profile_picture_url?: string;
      headline?: string;
      location?: string;
      network_distance?: string;
      shared_connections_count?: number;
      // Company fields
      industry?: string;
      employee_count?: number;
      website?: string;
      description?: string;
      // Job fields
      company_name?: string;
      job_title?: string;
      posted_at?: string;
    }>;
    cursor?: string;
  }>('POST', endpoint, body);

  // Transform Unipile response to our format
  return {
    items: (response.items || []).map(item => ({
      id: item.id,
      provider_id: item.id,
      public_identifier: item.public_identifier || '',
      full_name: item.name,
      headline: item.headline,
      location: item.location,
      profile_url: item.profile_url || '',
      picture_url: item.profile_picture_url,
      connection_degree: item.network_distance === 'DISTANCE_1' ? 1
        : item.network_distance === 'DISTANCE_2' ? 2
        : item.network_distance === 'DISTANCE_3' ? 3 : undefined,
      // Additional fields for companies/jobs
      industry: item.industry,
      employee_count: item.employee_count,
      website: item.website,
      description: item.description,
      company_name: item.company_name,
      job_title: item.job_title,
      posted_at: item.posted_at,
    })),
    cursor: response.cursor,
    has_more: !!response.cursor,
  };
}

// ============ Company Search ============

export interface CompanySearchParams {
  url?: string;
  keywords?: string;
  location?: string;
  industry?: string;
  has_job_offers?: boolean;
  company_size?: string[];  // ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'] = 1, 2-10, 11-50, 51-200, 201-500, 501-1000, 1001-5000, 5001-10000, 10001+
  cursor?: string;
}

export interface CompanyResult {
  id: string;
  name: string;
  public_identifier?: string;
  profile_url?: string;
  logo_url?: string;
  industry?: string;
  location?: string;
  employee_count?: number;
  employee_range?: string;
  website?: string;
  description?: string;
  specialties?: string[];
  founded_year?: number;
  has_job_offers?: boolean;
}

export interface CompanySearchResponse {
  items: CompanyResult[];
  cursor?: string;
  has_more: boolean;
}

export async function searchCompanies(
  accountId: string,
  params: CompanySearchParams
): Promise<CompanySearchResponse> {
  const body: Record<string, unknown> = {
    api: 'classic',
    category: 'companies',
  };

  if (params.url) {
    body.url = params.url;
  } else {
    if (params.keywords) {
      body.keywords = params.keywords;
    }
    if (params.has_job_offers !== undefined) {
      body.has_job_offers = params.has_job_offers;
    }
    if (params.company_size?.length) {
      body.company_headcount = params.company_size;
    }
    if (params.industry) {
      body.industry = { include: [params.industry] };
    }
  }

  if (params.cursor) {
    body.cursor = params.cursor;
  }

  const endpoint = `/linkedin/search?account_id=${encodeURIComponent(accountId)}`;

  const response = await apiRequest<{
    object: string;
    items: Array<{
      id: string;
      name: string;
      public_identifier?: string;
      profile_url?: string;
      profile_picture_url?: string;
      industry?: string;
      location?: string;
      employee_count?: number;
      employee_count_range?: string;
      website?: string;
      description?: string;
      specialties?: string[];
      founded_year?: number;
      has_job_offers?: boolean;
    }>;
    cursor?: string;
  }>('POST', endpoint, body);

  return {
    items: (response.items || []).map(item => ({
      id: item.id,
      name: item.name,
      public_identifier: item.public_identifier,
      profile_url: item.profile_url,
      logo_url: item.profile_picture_url,
      industry: item.industry,
      location: item.location,
      employee_count: item.employee_count,
      employee_range: item.employee_count_range,
      website: item.website,
      description: item.description,
      specialties: item.specialties,
      founded_year: item.founded_year,
      has_job_offers: item.has_job_offers,
    })),
    cursor: response.cursor,
    has_more: !!response.cursor,
  };
}

// ============ Job Search ============

export interface JobSearchParams {
  url?: string;
  keywords?: string;
  location?: string;
  company?: string;
  job_type?: 'full_time' | 'part_time' | 'contract' | 'internship';
  experience_level?: 'entry' | 'associate' | 'mid_senior' | 'director' | 'executive';
  remote?: boolean;
  posted_within?: 'day' | 'week' | 'month';
  cursor?: string;
}

export interface JobResult {
  id: string;
  title: string;
  company_name: string;
  company_id?: string;
  company_logo?: string;
  location?: string;
  job_url?: string;
  description?: string;
  posted_at?: string;
  applicants_count?: number;
  job_type?: string;
  experience_level?: string;
  is_remote?: boolean;
}

export interface JobSearchResponse {
  items: JobResult[];
  cursor?: string;
  has_more: boolean;
}

export async function searchJobs(
  accountId: string,
  params: JobSearchParams
): Promise<JobSearchResponse> {
  const body: Record<string, unknown> = {
    api: 'classic',
    category: 'jobs',
  };

  if (params.url) {
    body.url = params.url;
  } else {
    // Construct a LinkedIn job search URL from parameters
    // This is more reliable than passing individual parameters
    const urlParams = new URLSearchParams();

    if (params.keywords) {
      urlParams.set('keywords', params.keywords);
    }
    if (params.location) {
      urlParams.set('location', params.location);
    }

    // Job type mapping: LinkedIn uses f_JT parameter
    if (params.job_type) {
      const jobTypeMap: Record<string, string> = {
        'full_time': 'F',
        'part_time': 'P',
        'contract': 'C',
        'internship': 'I',
      };
      urlParams.set('f_JT', jobTypeMap[params.job_type] || 'F');
    }

    // Experience level mapping: LinkedIn uses f_E parameter
    if (params.experience_level) {
      const expMap: Record<string, string> = {
        'entry': '2',
        'associate': '3',
        'mid_senior': '4',
        'director': '5',
        'executive': '6',
      };
      urlParams.set('f_E', expMap[params.experience_level] || '4');
    }

    // Remote filter: LinkedIn uses f_WT parameter (2 = remote)
    if (params.remote) {
      urlParams.set('f_WT', '2');
    }

    // Posted within: LinkedIn uses f_TPR parameter
    if (params.posted_within) {
      const timeMap: Record<string, string> = {
        'day': 'r86400',
        'week': 'r604800',
        'month': 'r2592000',
      };
      urlParams.set('f_TPR', timeMap[params.posted_within] || 'r604800');
    }

    // Company filter
    if (params.company) {
      urlParams.set('f_C', params.company);
    }

    const searchUrl = `https://www.linkedin.com/jobs/search/?${urlParams.toString()}`;
    body.url = searchUrl;
  }

  if (params.cursor) {
    body.cursor = params.cursor;
  }

  const endpoint = `/linkedin/search?account_id=${encodeURIComponent(accountId)}`;

  const response = await apiRequest<{
    object: string;
    items: Array<{
      id: string;
      name?: string;
      title?: string;
      company_name?: string;
      company_id?: string;
      company_logo?: string;
      location?: string;
      job_url?: string;
      profile_url?: string;
      description?: string;
      posted_at?: string;
      applicants_count?: number;
      job_type?: string;
      experience_level?: string;
      is_remote?: boolean;
    }>;
    cursor?: string;
  }>('POST', endpoint, body);

  return {
    items: (response.items || []).map(item => ({
      id: item.id,
      title: item.title || item.name || 'Unknown',
      company_name: item.company_name || '',
      company_id: item.company_id,
      company_logo: item.company_logo,
      location: item.location,
      job_url: item.job_url || item.profile_url,
      description: item.description,
      posted_at: item.posted_at,
      applicants_count: item.applicants_count,
      job_type: item.job_type,
      experience_level: item.experience_level,
      is_remote: item.is_remote,
    })),
    cursor: response.cursor,
    has_more: !!response.cursor,
  };
}

// ============ Search Parameters (for getting location/industry IDs) ============

export interface SearchParameter {
  id: string;
  name: string;
  type: string;
}

export async function getSearchParameters(
  accountId: string,
  type: 'LOCATION' | 'INDUSTRY' | 'COMPANY' | 'SCHOOL' | 'SKILL',
  keywords: string
): Promise<SearchParameter[]> {
  const params = new URLSearchParams();
  params.set('account_id', accountId);
  params.set('type', type);
  params.set('keywords', keywords);
  params.set('limit', '20');

  const response = await apiRequest<{
    items: Array<{
      id: string;
      name: string;
      type: string;
    }>;
  }>('GET', `/linkedin/search/parameters?${params.toString()}`);

  return response.items || [];
}

// ============ Company Profile ============

export interface CompanyProfile {
  id: string;
  name: string;
  public_identifier?: string;
  profile_url?: string;
  logo_url?: string;
  industry?: string;
  location?: string;
  headquarters?: string;
  employee_count?: number;
  employee_range?: string;
  website?: string;
  phone?: string;
  description?: string;
  specialties?: string[];
  founded_year?: number;
  company_type?: string;
}

export async function getCompanyProfile(
  accountId: string,
  identifier: string
): Promise<CompanyProfile> {
  // Use company search to get profile details
  // The identifier can be a company name, URL, or public identifier
  const isUrl = identifier.includes('linkedin.com/company/');

  const body: Record<string, unknown> = {
    api: 'classic',
    category: 'companies',
  };

  if (isUrl) {
    body.url = identifier;
  } else {
    // Search by company name/identifier
    body.keywords = identifier;
  }

  const endpoint = `/linkedin/search?account_id=${encodeURIComponent(accountId)}`;

  const response = await apiRequest<{
    object: string;
    items: Array<{
      id: string;
      name: string;
      public_identifier?: string;
      profile_url?: string;
      profile_picture_url?: string;
      industry?: string;
      location?: string;
      headquarters?: string;
      employee_count?: number;
      employee_count_range?: string;
      website?: string;
      phone?: string;
      description?: string;
      specialties?: string[];
      founded_year?: number;
      company_type?: string;
    }>;
  }>('POST', endpoint, body);

  const company = response.items?.[0];
  if (!company) {
    throw new Error(`Company not found: ${identifier}`);
  }

  return {
    id: company.id,
    name: company.name,
    public_identifier: company.public_identifier,
    profile_url: company.profile_url,
    logo_url: company.profile_picture_url,
    industry: company.industry,
    location: company.location,
    headquarters: company.headquarters,
    employee_count: company.employee_count,
    employee_range: company.employee_count_range,
    website: company.website,
    phone: company.phone,
    description: company.description,
    specialties: company.specialties,
    founded_year: company.founded_year,
    company_type: company.company_type,
  };
}

// ============ Profile ============

export interface ProfileDetails {
  id: string;
  provider_id: string;
  public_identifier: string;
  full_name: string;
  first_name?: string;
  last_name?: string;
  headline?: string;
  summary?: string;
  location?: string;
  profile_url: string;
  picture_url?: string;
  connection_degree?: number;
  is_connection?: boolean;
  current_company?: string;
  current_position?: string;
  experience?: Array<{
    company: string;
    title: string;
    start_date?: string;
    end_date?: string;
    is_current?: boolean;
  }>;
}

export async function getProfile(
  accountId: string,
  identifier: string  // Can be provider_id, public_identifier, or profile URL
): Promise<ProfileDetails> {
  // account_id must be in query string, not header
  const response = await apiRequest<{
    object: string;
    provider: string;
    provider_id: string;
    public_identifier: string;
    first_name?: string;
    last_name?: string;
    headline?: string;
    location?: string;
    profile_picture_url?: string;
    network_distance?: string;
    is_relationship?: boolean;
    summary?: string;
  }>(
    'GET',
    `/users/${encodeURIComponent(identifier)}?account_id=${encodeURIComponent(accountId)}`
  );

  // Transform Unipile response to our ProfileDetails format
  return {
    id: response.provider_id,
    provider_id: response.provider_id,
    public_identifier: response.public_identifier,
    full_name: [response.first_name, response.last_name].filter(Boolean).join(' ') || 'Unknown',
    first_name: response.first_name,
    last_name: response.last_name,
    headline: response.headline,
    summary: response.summary,
    location: response.location,
    profile_url: `https://www.linkedin.com/in/${response.public_identifier}`,
    picture_url: response.profile_picture_url,
    connection_degree: response.network_distance === 'FIRST_DEGREE' ? 1
      : response.network_distance === 'SECOND_DEGREE' ? 2
      : response.network_distance === 'THIRD_DEGREE' ? 3 : undefined,
    is_connection: response.is_relationship,
  };
}

// ============ Connections/Relations ============

export interface Relation {
  id: string;
  provider_id: string;
  public_identifier: string;
  full_name: string;
  headline?: string;
  picture_url?: string;
  connected_at?: string;
}

export interface RelationsResponse {
  items: Relation[];
  cursor?: string;
  has_more: boolean;
}

export async function getRelations(
  accountId: string,
  cursor?: string
): Promise<RelationsResponse> {
  const params = new URLSearchParams();
  params.set('account_id', accountId);
  if (cursor) params.set('cursor', cursor);

  return apiRequest<RelationsResponse>('GET', `/users/relations?${params.toString()}`);
}

// ============ Invitations ============

export interface Invitation {
  id: string;
  provider_id: string;
  full_name: string;
  headline?: string;
  status: 'pending' | 'accepted' | 'declined';
  sent_at: string;
  message?: string;
}

export interface InvitationsResponse {
  items: Invitation[];
  cursor?: string;
  has_more: boolean;
}

// Note: getSentInvitations removed - endpoint doesn't exist in Unipile API
// Use getRelations() and compare against saved invitations to detect accepted ones

export interface SendInvitationParams {
  provider_id: string;
  message?: string;  // Max 300 chars for paid accounts, 200 for free
}

export interface SendInvitationResponse {
  success: boolean;
  invitation_id?: string;
  error?: string;
}

export async function sendInvitation(
  accountId: string,
  params: SendInvitationParams
): Promise<SendInvitationResponse> {
  return apiRequest<SendInvitationResponse>('POST', '/users/invite', {
    account_id: accountId,
    provider_id: params.provider_id,
    message: params.message,
  });
}

// ============ Messages ============

export interface Chat {
  id: string;
  provider_id: string;
  participant_name: string;
  participant_id: string;
  last_message?: string;
  last_message_at?: string;
  unread_count?: number;
}

export interface ChatsResponse {
  items: Chat[];
  cursor?: string;
  has_more: boolean;
}

export async function getChats(
  accountId: string,
  cursor?: string
): Promise<ChatsResponse> {
  const params = new URLSearchParams();
  params.set('account_id', accountId);
  if (cursor) params.set('cursor', cursor);

  return apiRequest<ChatsResponse>('GET', `/chats?${params.toString()}`);
}

export interface Message {
  id: string;
  sender_id: string;
  sender_name: string;
  text: string;
  sent_at: string;
  is_outgoing: boolean;
}

export interface MessagesResponse {
  items: Message[];
  cursor?: string;
  has_more: boolean;
}

export async function getChatMessages(
  accountId: string,
  chatId: string,
  cursor?: string
): Promise<MessagesResponse> {
  const params = new URLSearchParams();
  params.set('account_id', accountId);
  if (cursor) params.set('cursor', cursor);

  return apiRequest<MessagesResponse>('GET', `/chats/${chatId}/messages?${params.toString()}`);
}

export interface SendMessageParams {
  recipient_id: string;  // provider_id of the recipient (must be a connection)
  text: string;
}

export interface SendMessageResponse {
  success: boolean;
  message_id?: string;
  chat_id?: string;
  error?: string;
}

export async function sendMessage(
  accountId: string,
  params: SendMessageParams
): Promise<SendMessageResponse> {
  const response = await apiRequest<{
    object: string;
    chat_id: string;
    message_id: string;
  }>('POST', '/chats', {
    account_id: accountId,
    attendees_ids: [params.recipient_id],
    text: params.text,
  });

  return {
    success: true,
    message_id: response.message_id,
    chat_id: response.chat_id,
  };
}

// ============ Posts & Engagement ============

export interface Post {
  id: string;
  social_id: string;  // Use this for all post operations
  author_id: string;
  author_name: string;
  text: string;
  posted_at: string;
  likes_count?: number;
  comments_count?: number;
  shares_count?: number;
}

export interface PostsResponse {
  items: Post[];
  cursor?: string;
  has_more: boolean;
}

export async function getUserPosts(
  accountId: string,
  userId: string,
  cursor?: string
): Promise<PostsResponse> {
  const params = new URLSearchParams();
  params.set('account_id', accountId);
  if (cursor) params.set('cursor', cursor);

  return apiRequest<PostsResponse>('GET', `/users/${userId}/posts?${params.toString()}`);
}

export async function getPost(
  accountId: string,
  postId: string
): Promise<Post> {
  const params = new URLSearchParams();
  params.set('account_id', accountId);

  return apiRequest<Post>('GET', `/posts/${postId}?${params.toString()}`);
}

export interface CreatePostParams {
  text: string;
}

export interface CreatePostResponse {
  success: boolean;
  post_id?: string;
  social_id?: string;
  error?: string;
}

export async function createPost(
  accountId: string,
  params: CreatePostParams
): Promise<CreatePostResponse> {
  return apiRequest<CreatePostResponse>('POST', '/posts', {
    account_id: accountId,
    text: params.text,
  });
}

// Note: reactToPost and commentOnPost removed - endpoints return 404 in Unipile API
// These features may be available via the raw route (/api/v1/linkedin) in the future

// ============ Post Search ============

export interface PostSearchParams {
  url?: string;                // Paste a LinkedIn content-search URL; other params ignored if set
  keywords?: string;
  posted_within?: 'past_24h' | 'past_week' | 'past_month';
  sort_by?: 'relevance' | 'date_posted';
  from_member?: string[];      // LinkedIn member IDs (urn:li:fsd_profile:...) to filter posts by
  from_company?: string[];     // Company URNs (urn:li:fsd_company:...) to filter posts by
  mentions_member?: string[];
  mentions_company?: string[];
  cursor?: string;
}

export interface PostAuthor {
  id?: string;
  public_identifier?: string;
  name?: string;
  is_company?: boolean;
  headline?: string;
  profile_picture_url?: string;
}

export interface PostSearchResult {
  id: string;
  social_id: string;           // urn:li:activity:... — used for get_post, comments, reactions
  type: string;                // POST | REPOST | etc.
  share_url: string;
  text: string;
  date: string;                // relative (e.g., "1w")
  parsed_datetime?: string;    // ISO 8601
  reaction_count: number;
  comment_count: number;
  repost_count: number;
  impressions_count?: number;
  is_repost?: boolean;
  author?: PostAuthor;
  mentions?: unknown[];
  attachments?: unknown[];
}

export interface PostSearchResponse {
  items: PostSearchResult[];
  cursor?: string;
  has_more: boolean;
}

export async function searchPosts(
  accountId: string,
  params: PostSearchParams
): Promise<PostSearchResponse> {
  const body: Record<string, unknown> = {
    api: 'classic',
    category: 'posts',
  };

  if (params.url) {
    body.url = params.url;
  } else if (params.keywords) {
    body.keywords = params.keywords;
  }

  // NOTE: Unipile's "Classic - Posts" schema rejects date_posted/sort_by/from_member with HTTP 400.
  // For time-filtering or author-filtering today, pass a fully-formed LinkedIn content-search URL
  // via the `url` param (with f_TPR=r604800 etc. baked in). Verifying the exact valid post-search
  // filter field names is a follow-up; the above params are documented but currently inactive.

  if (params.cursor) {
    body.cursor = params.cursor;
  }

  const endpoint = `/linkedin/search?account_id=${encodeURIComponent(accountId)}`;

  const response = await apiRequest<{
    object: string;
    items: Array<{
      id?: string | number;
      social_id?: string;
      type?: string;
      share_url?: string;
      text?: string;
      date?: string;
      parsed_datetime?: string;
      reaction_counter?: number;
      comment_counter?: number;
      repost_counter?: number;
      impressions_counter?: number;
      is_repost?: boolean;
      author?: PostAuthor;
      mentions?: unknown[];
      attachments?: unknown[];
    }>;
    cursor?: string;
  }>('POST', endpoint, body);

  return {
    items: (response.items || []).map(item => ({
      id: String(item.id ?? item.social_id ?? ''),
      social_id: item.social_id || String(item.id ?? ''),
      type: item.type || 'POST',
      share_url: item.share_url || '',
      text: item.text || '',
      date: item.date || '',
      parsed_datetime: item.parsed_datetime,
      reaction_count: item.reaction_counter ?? 0,
      comment_count: item.comment_counter ?? 0,
      repost_count: item.repost_counter ?? 0,
      impressions_count: item.impressions_counter,
      is_repost: item.is_repost,
      author: item.author,
      mentions: item.mentions,
      attachments: item.attachments,
    })),
    cursor: response.cursor,
    has_more: !!response.cursor,
  };
}

// ============ Account Info ============

export interface AccountInfo {
  id: string;
  provider: string;
  status: string;
  user_id?: string;
  user_name?: string;
}

export async function getAccountInfo(accountId: string): Promise<AccountInfo> {
  return apiRequest<AccountInfo>('GET', `/accounts/${accountId}`);
}

export async function getMyProfile(accountId: string): Promise<ProfileDetails> {
  return apiRequest<ProfileDetails>(
    'GET',
    '/users/me',
    undefined,
    { 'account_id': accountId }
  );
}

// ============ Profile Viewers ============

export interface ProfileViewer {
  id: string;
  provider_id: string;
  public_identifier?: string;
  full_name: string;
  headline?: string;
  picture_url?: string;
  viewed_at?: string;
}

export interface ProfileViewersResponse {
  items: ProfileViewer[];
  cursor?: string;
  has_more: boolean;
}

export async function getProfileViewers(
  accountId: string,
  cursor?: string
): Promise<ProfileViewersResponse> {
  // Use LinkedIn raw endpoint for profile viewers
  const response = await apiRequest<{
    object: string;
    data?: unknown;
    items?: Array<{
      id?: string;
      provider_id?: string;
      public_identifier?: string;
      name?: string;
      first_name?: string;
      last_name?: string;
      headline?: string;
      profile_picture_url?: string;
      viewed_at?: string;
    }>;
    cursor?: string;
  }>('POST', '/linkedin/raw', {
    account_id: accountId,
    url: '/voyager/api/identity/wvmpCards',
    cursor,
  });

  // Parse the response - raw endpoint returns data in different formats
  const items = response.items || [];

  return {
    items: items.map(item => ({
      id: item.id || item.provider_id || '',
      provider_id: item.provider_id || item.id || '',
      public_identifier: item.public_identifier,
      full_name: item.name || [item.first_name, item.last_name].filter(Boolean).join(' ') || 'Unknown',
      headline: item.headline,
      picture_url: item.profile_picture_url,
      viewed_at: item.viewed_at,
    })),
    cursor: response.cursor,
    has_more: !!response.cursor,
  };
}

// ============ InMail (Sales Navigator / Recruiter) ============

export interface SendInMailParams {
  recipient_id: string;  // provider_id of the recipient
  subject: string;       // InMail subject line
  text: string;          // InMail body
}

export interface SendInMailResponse {
  success: boolean;
  message_id?: string;
  chat_id?: string;
  error?: string;
  credits_remaining?: number;
}

export async function sendInMail(
  accountId: string,
  params: SendInMailParams
): Promise<SendInMailResponse> {
  // InMail uses a different endpoint than regular messages
  // It can reach non-connections with Sales Navigator or Recruiter
  const response = await apiRequest<{
    object: string;
    chat_id?: string;
    message_id?: string;
    credits_remaining?: number;
  }>('POST', '/chats', {
    account_id: accountId,
    attendees_ids: [params.recipient_id],
    subject: params.subject,  // InMails have subjects unlike regular messages
    text: params.text,
    message_type: 'inmail',  // Specify InMail type
  });

  return {
    success: true,
    message_id: response.message_id,
    chat_id: response.chat_id,
    credits_remaining: response.credits_remaining,
  };
}

// Check if a profile accepts free InMail (open profile)
export interface ProfileInMailStatus {
  provider_id: string;
  can_send_inmail: boolean;
  is_open_profile: boolean;  // Open profiles accept free InMails
  inmail_credits_required: number;  // 0 for open profiles
  credits_remaining?: number;
}

export async function checkInMailStatus(
  accountId: string,
  identifier: string
): Promise<ProfileInMailStatus> {
  // First get the profile to check open profile status
  const profile = await apiRequest<{
    provider_id: string;
    public_identifier?: string;
    is_open_profile?: boolean;
    open_link?: boolean;
    premium?: boolean;
  }>(
    'GET',
    `/users/${encodeURIComponent(identifier)}?account_id=${encodeURIComponent(accountId)}`
  );

  // Try to get InMail balance (may fail if not Sales Navigator)
  let creditsRemaining: number | undefined;
  try {
    const balance = await apiRequest<{
      credits?: number;
      remaining?: number;
    }>('GET', `/linkedin/inmail/balance?account_id=${encodeURIComponent(accountId)}`);
    creditsRemaining = balance.credits ?? balance.remaining;
  } catch {
    // InMail balance not available (probably no Sales Navigator)
  }

  const isOpenProfile = profile.is_open_profile ?? profile.open_link ?? false;

  return {
    provider_id: profile.provider_id,
    can_send_inmail: true,  // Assume yes if we got this far
    is_open_profile: isOpenProfile,
    inmail_credits_required: isOpenProfile ? 0 : 1,
    credits_remaining: creditsRemaining,
  };
}

// Get InMail credit balance
export interface InMailBalance {
  credits_remaining: number;
  credits_used: number;
  credits_total: number;
}

export async function getInMailBalance(accountId: string): Promise<InMailBalance> {
  const response = await apiRequest<{
    credits?: number;
    remaining?: number;
    used?: number;
    total?: number;
  }>('GET', `/linkedin/inmail/balance?account_id=${encodeURIComponent(accountId)}`);

  return {
    credits_remaining: response.remaining ?? response.credits ?? 0,
    credits_used: response.used ?? 0,
    credits_total: response.total ?? 0,
  };
}

// Export config getter for initialization check
export function isConfigured(): boolean {
  return !!(config.apiKey && config.dsn);
}

export function getAccountId(): string {
  return config.accountId;
}

export function setAccountId(accountId: string): void {
  config.accountId = accountId;
}
