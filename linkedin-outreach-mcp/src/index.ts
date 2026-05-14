#!/usr/bin/env node
/**
 * LinkedIn Outreach MCP Server
 * Provides tools for LinkedIn automation via Unipile API
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import * as unipile from './unipile-client.js';
import * as db from './db/schema.js';

// Rate limits configuration
const RATE_LIMITS = {
  invitation: { daily: 40, weekly: 180 },  // Conservative limits
  message: { daily: 80 },
  profile_view: { daily: 90 },
  post_action: { daily: 50 },
  search: { daily: 20 },
  inmail: { daily: 25 },  // InMail credits are precious, be conservative
};

// Create MCP server
const server = new Server(
  {
    name: 'linkedin-outreach',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ============ Tool Definitions ============

const tools: Tool[] = [
  // Search Tools
  {
    name: 'search_linkedin',
    description: 'Search LinkedIn for prospects by criteria. Returns profiles matching the search.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'LinkedIn search URL (copy from browser). If provided, other params are ignored.',
        },
        keywords: {
          type: 'string',
          description: 'Keywords to search for (name, title, skills, etc.)',
        },
        title: {
          type: 'string',
          description: 'Job title to filter by',
        },
        company: {
          type: 'string',
          description: 'Company name to filter by',
        },
        location: {
          type: 'string',
          description: 'Location to filter by',
        },
        save_results: {
          type: 'boolean',
          description: 'Whether to save results as prospects (default: true)',
          default: true,
        },
        source_tag: {
          type: 'string',
          description: 'Tag to identify this search batch (e.g., "SF CTOs Jan 2025")',
        },
        // Advanced filters
        api_type: {
          type: 'string',
          enum: ['classic', 'sales_navigator', 'recruiter'],
          description: 'LinkedIn API to use (default: classic). sales_navigator and recruiter require subscriptions.',
        },
        network_distance: {
          type: 'array',
          items: { type: 'number', enum: [1, 2, 3] },
          description: 'Filter by connection degree: 1 (1st), 2 (2nd), 3 (3rd+)',
        },
        tenure_min: {
          type: 'number',
          description: 'Minimum years at current company',
        },
        tenure_max: {
          type: 'number',
          description: 'Maximum years at current company',
        },
        company_size: {
          type: 'array',
          items: { type: 'string' },
          description: 'Company size codes: A=1, B=2-10, C=11-50, D=51-200, E=201-500, F=501-1000, G=1001-5000, H=5001-10000, I=10001+',
        },
        profile_language: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by profile language (e.g., ["en", "es"])',
        },
      },
    },
  },
  {
    name: 'search_companies',
    description: 'Search LinkedIn for companies by criteria. Returns company profiles with industry, size, and job openings info.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'LinkedIn company search URL (copy from browser). If provided, other params are ignored.',
        },
        keywords: {
          type: 'string',
          description: 'Company name or industry keywords',
        },
        location: {
          type: 'string',
          description: 'Location to filter by',
        },
        industry: {
          type: 'string',
          description: 'Industry to filter by',
        },
        has_job_offers: {
          type: 'boolean',
          description: 'Only show companies with active job postings',
        },
        company_size: {
          type: 'array',
          items: { type: 'string' },
          description: 'Company size codes: A=1, B=2-10, C=11-50, D=51-200, E=201-500, F=501-1000, G=1001-5000, H=5001-10000, I=10001+',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 10)',
          default: 10,
        },
      },
    },
  },
  {
    name: 'search_jobs',
    description: 'Search LinkedIn for job postings. Returns job listings with company, location, and posting details.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'LinkedIn job search URL (copy from browser). If provided, other params are ignored.',
        },
        keywords: {
          type: 'string',
          description: 'Job title or skills keywords',
        },
        location: {
          type: 'string',
          description: 'Location to filter by',
        },
        company: {
          type: 'string',
          description: 'Company name to filter by',
        },
        job_type: {
          type: 'string',
          enum: ['full_time', 'part_time', 'contract', 'internship'],
          description: 'Type of employment',
        },
        experience_level: {
          type: 'string',
          enum: ['entry', 'associate', 'mid_senior', 'director', 'executive'],
          description: 'Required experience level',
        },
        remote: {
          type: 'boolean',
          description: 'Filter for remote jobs only',
        },
        posted_within: {
          type: 'string',
          enum: ['day', 'week', 'month'],
          description: 'Only show jobs posted within this timeframe',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 10)',
          default: 10,
        },
      },
    },
  },
  {
    name: 'get_company_profile',
    description: 'Get detailed company profile including industry, employee count, website, description, and specialties.',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          description: 'Company LinkedIn URL, public identifier (e.g., "google"), or company ID',
        },
      },
      required: ['identifier'],
    },
  },
  {
    name: 'get_search_parameters',
    description: 'Get LinkedIn search parameter IDs for locations, industries, companies, schools, or skills. Use these IDs for advanced filtering.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['LOCATION', 'INDUSTRY', 'COMPANY', 'SCHOOL', 'SKILL'],
          description: 'Type of parameter to search for',
        },
        keywords: {
          type: 'string',
          description: 'Keywords to search for (e.g., "San Francisco" for LOCATION, "Software" for INDUSTRY)',
        },
      },
      required: ['type', 'keywords'],
    },
  },
  {
    name: 'get_profile',
    description: 'Get detailed profile information for a LinkedIn user',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          description: 'LinkedIn profile URL, public identifier (e.g., "johndoe"), or provider ID',
        },
      },
      required: ['identifier'],
    },
  },

  // Prospect Management
  {
    name: 'get_prospects',
    description: 'Get saved prospects with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        source_search: {
          type: 'string',
          description: 'Filter by source search tag',
        },
        is_connection: {
          type: 'boolean',
          description: 'Filter by connection status',
        },
        not_enrolled: {
          type: 'boolean',
          description: 'Only show prospects not enrolled in any sequence',
        },
        limit: {
          type: 'number',
          description: 'Maximum number to return (default: 50)',
          default: 50,
        },
      },
    },
  },
  {
    name: 'update_prospect',
    description: 'Update a prospect with tags or notes',
    inputSchema: {
      type: 'object',
      properties: {
        prospect_id: {
          type: 'string',
          description: 'Prospect ID to update',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags to add to the prospect',
        },
        notes: {
          type: 'string',
          description: 'Notes about this prospect',
        },
      },
      required: ['prospect_id'],
    },
  },

  // Invitations & Connections
  {
    name: 'send_invitation',
    description: 'Send a LinkedIn connection invitation to a prospect. Requires the prospect to be saved first.',
    inputSchema: {
      type: 'object',
      properties: {
        prospect_id: {
          type: 'string',
          description: 'Prospect ID (from saved prospects)',
        },
        message: {
          type: 'string',
          description: 'Connection request message (max 300 chars). Use {{first_name}} for personalization.',
        },
      },
      required: ['prospect_id'],
    },
  },
  {
    name: 'check_new_connections',
    description: 'Check for new accepted connections and update sequence enrollments accordingly',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  // Note: list_sent_invitations removed - Unipile API doesn't support this endpoint

  // Messaging
  {
    name: 'send_message',
    description: 'Send a message to a connected LinkedIn user',
    inputSchema: {
      type: 'object',
      properties: {
        prospect_id: {
          type: 'string',
          description: 'Prospect ID (must be a connection)',
        },
        message: {
          type: 'string',
          description: 'Message text. Use {{first_name}}, {{company}} for personalization.',
        },
      },
      required: ['prospect_id', 'message'],
    },
  },

  // Sequence Management
  {
    name: 'create_sequence',
    description: 'Create a new outreach sequence (campaign)',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the sequence',
        },
        description: {
          type: 'string',
          description: 'Description of the sequence purpose',
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['visit_profile', 'send_invitation', 'wait_for_acceptance', 'send_message', 'send_followup', 'delay'],
              },
              delay_days: {
                type: 'number',
                description: 'Days to wait before this step',
              },
              timeout_days: {
                type: 'number',
                description: 'For wait_for_acceptance: days to wait before giving up',
              },
              message: {
                type: 'string',
                description: 'Message template (supports {{first_name}}, {{company}}, etc.)',
              },
            },
            required: ['type'],
          },
          description: 'Steps in the sequence',
        },
      },
      required: ['name', 'steps'],
    },
  },
  {
    name: 'list_sequences',
    description: 'List all outreach sequences',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['draft', 'active', 'paused', 'completed'],
          description: 'Filter by status',
        },
      },
    },
  },
  {
    name: 'activate_sequence',
    description: 'Activate a draft sequence to start running',
    inputSchema: {
      type: 'object',
      properties: {
        sequence_id: {
          type: 'string',
          description: 'Sequence ID to activate',
        },
      },
      required: ['sequence_id'],
    },
  },
  {
    name: 'pause_sequence',
    description: 'Pause an active sequence',
    inputSchema: {
      type: 'object',
      properties: {
        sequence_id: {
          type: 'string',
          description: 'Sequence ID to pause',
        },
      },
      required: ['sequence_id'],
    },
  },
  {
    name: 'enroll_prospects',
    description: 'Enroll prospects into a sequence',
    inputSchema: {
      type: 'object',
      properties: {
        sequence_id: {
          type: 'string',
          description: 'Sequence ID to enroll into',
        },
        prospect_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of prospect IDs to enroll',
        },
        source_search: {
          type: 'string',
          description: 'Alternatively, enroll all prospects from a search tag',
        },
      },
      required: ['sequence_id'],
    },
  },
  {
    name: 'run_sequence_actions',
    description: 'Execute pending sequence actions (respects rate limits)',
    inputSchema: {
      type: 'object',
      properties: {
        sequence_id: {
          type: 'string',
          description: 'Run actions for a specific sequence only',
        },
        max_actions: {
          type: 'number',
          description: 'Maximum actions to run (default: 10)',
          default: 10,
        },
      },
    },
  },
  {
    name: 'get_sequence_status',
    description: 'Get status and metrics for a sequence',
    inputSchema: {
      type: 'object',
      properties: {
        sequence_id: {
          type: 'string',
          description: 'Sequence ID to get status for',
        },
      },
      required: ['sequence_id'],
    },
  },

  // Rate Limits & Dashboard
  {
    name: 'get_daily_limits',
    description: 'Get current rate limit usage for today',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_action_history',
    description: 'Get recent action history',
    inputSchema: {
      type: 'object',
      properties: {
        action_type: {
          type: 'string',
          description: 'Filter by action type (invitation_sent, message_sent, etc.)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number to return (default: 50)',
          default: 50,
        },
      },
    },
  },

  // Messaging
  {
    name: 'get_chats',
    description: 'Get recent LinkedIn chat conversations (inbox)',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of chats to return (default: 20)',
          default: 20,
        },
      },
    },
  },
  {
    name: 'get_chat_messages',
    description: 'Get messages from a specific chat conversation',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: {
          type: 'string',
          description: 'Chat ID to get messages from',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of messages to return (default: 20)',
          default: 20,
        },
      },
      required: ['chat_id'],
    },
  },

  // Posts
  {
    name: 'search_posts',
    description: 'Search LinkedIn feed/posts by keyword. Returns posts with text, author, engagement metrics (reactions, comments, reposts), and share URL. Powerful for finding parents discussing a topic, SLPs posting in your niche, or potential outreach targets based on their public content. For time-filtering or author-filtering, pass a fully-formed LinkedIn content-search URL via `url` (e.g., copy from linkedin.com/search/results/content/?keywords=...&datePosted=%22past-month%22).',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'LinkedIn content-search URL (e.g., from linkedin.com/search/results/content/?keywords=...). If provided, other params are ignored.',
        },
        keywords: {
          type: 'string',
          description: 'Search keywords (e.g., "speech delay toddler", "early intervention parent")',
        },
        posted_within: {
          type: 'string',
          enum: ['past_24h', 'past_week', 'past_month'],
          description: 'Limit to posts within a recent time window',
        },
        sort_by: {
          type: 'string',
          enum: ['relevance', 'date_posted'],
          description: 'Sort order (default: relevance)',
        },
        from_member: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter to posts authored by specific LinkedIn member URNs',
        },
        from_company: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter to posts from specific company URNs',
        },
        mentions_member: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter to posts that mention specific member URNs',
        },
        mentions_company: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter to posts that mention specific company URNs',
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor from a previous response',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10)',
          default: 10,
        },
      },
    },
  },
  {
    name: 'get_user_posts',
    description: 'Get recent posts from a LinkedIn user. Use this to check if someone is posting about hiring, company updates, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: {
          type: 'string',
          description: 'LinkedIn user ID (provider_id/linkedin_id from prospect)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of posts to return (default: 10)',
          default: 10,
        },
      },
      required: ['user_id'],
    },
  },
  {
    name: 'get_post',
    description: 'Get details of a specific LinkedIn post',
    inputSchema: {
      type: 'object',
      properties: {
        post_id: {
          type: 'string',
          description: 'Post ID to retrieve',
        },
      },
      required: ['post_id'],
    },
  },

  // Content Creation
  {
    name: 'create_post',
    description: 'Create a new LinkedIn post. Use this for content marketing, thought leadership, or announcements.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The post content (text). Supports LinkedIn formatting.',
        },
      },
      required: ['text'],
    },
  },

  // Profile Insights
  {
    name: 'get_profile_viewers',
    description: 'Get a list of people who viewed your LinkedIn profile. Useful for identifying warm leads and engagement opportunities.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of viewers to return (default: 20)',
          default: 20,
        },
        save_as_prospects: {
          type: 'boolean',
          description: 'Whether to save viewers as prospects (default: true)',
          default: true,
        },
        source_tag: {
          type: 'string',
          description: 'Tag for saved prospects (default: "profile_viewers")',
        },
      },
    },
  },

  // InMail (Sales Navigator / Recruiter)
  {
    name: 'send_inmail',
    description: 'Send an InMail to a LinkedIn user (requires Sales Navigator or Recruiter). Can reach non-connections. Uses InMail credits unless recipient has an open profile.',
    inputSchema: {
      type: 'object',
      properties: {
        prospect_id: {
          type: 'string',
          description: 'Prospect ID to send InMail to',
        },
        subject: {
          type: 'string',
          description: 'InMail subject line (keep it compelling and concise)',
        },
        message: {
          type: 'string',
          description: 'InMail body text. Use {{first_name}}, {{company}} for personalization.',
        },
      },
      required: ['prospect_id', 'subject', 'message'],
    },
  },
  {
    name: 'check_inmail_status',
    description: 'Check if a prospect can receive InMail and whether they have an open profile (free InMail). Requires Sales Navigator.',
    inputSchema: {
      type: 'object',
      properties: {
        prospect_id: {
          type: 'string',
          description: 'Prospect ID to check InMail status for',
        },
      },
      required: ['prospect_id'],
    },
  },
];

// ============ Tool Handlers ============

// Helper: Check rate limit
function checkRateLimit(actionType: keyof typeof RATE_LIMITS): { allowed: boolean; current: number; limit: number; message?: string } {
  const limits = RATE_LIMITS[actionType];
  const dailyCount = db.getRateLimitCount(actionType);

  if (dailyCount >= limits.daily) {
    return {
      allowed: false,
      current: dailyCount,
      limit: limits.daily,
      message: `Daily limit reached for ${actionType}: ${dailyCount}/${limits.daily}`,
    };
  }

  if ('weekly' in limits) {
    const weeklyCount = db.getWeeklyRateLimitCount(actionType);
    if (weeklyCount >= limits.weekly) {
      return {
        allowed: false,
        current: weeklyCount,
        limit: limits.weekly,
        message: `Weekly limit reached for ${actionType}: ${weeklyCount}/${limits.weekly}`,
      };
    }
  }

  return { allowed: true, current: dailyCount, limit: limits.daily };
}

// Helper: Personalize message
function personalizeMessage(template: string, prospect: db.Prospect): string {
  return template
    .replace(/\{\{first_name\}\}/g, prospect.first_name || prospect.full_name.split(' ')[0])
    .replace(/\{\{last_name\}\}/g, prospect.last_name || '')
    .replace(/\{\{full_name\}\}/g, prospect.full_name)
    .replace(/\{\{company\}\}/g, prospect.company || 'your company')
    .replace(/\{\{headline\}\}/g, prospect.headline || '');
}

// Helper: Get account ID
function getAccountId(): string {
  const accountId = unipile.getAccountId();
  if (!accountId) {
    throw new Error('UNIPILE_ACCOUNT_ID environment variable not set');
  }
  return accountId;
}

// Tool handler implementations
async function handleSearchLinkedin(args: Record<string, unknown>): Promise<unknown> {
  const limitCheck = checkRateLimit('search');
  if (!limitCheck.allowed) {
    return { error: limitCheck.message, rate_limit: limitCheck };
  }

  const accountId = getAccountId();

  try {
    const results = await unipile.searchLinkedIn(accountId, {
      url: args.url as string | undefined,
      keywords: args.keywords as string | undefined,
      title: args.title as string | undefined,
      company: args.company as string | undefined,
      location: args.location as string | undefined,
      // Advanced filters
      api: args.api_type as 'classic' | 'sales_navigator' | 'recruiter' | undefined,
      network_distance: args.network_distance as number[] | undefined,
      tenure_min: args.tenure_min as number | undefined,
      tenure_max: args.tenure_max as number | undefined,
      company_size: args.company_size as string[] | undefined,
      profile_language: args.profile_language as string[] | undefined,
    });

    db.incrementRateLimit('search');

    const saveResults = args.save_results !== false;
    const sourceTag = args.source_tag as string || `search_${new Date().toISOString().split('T')[0]}`;

    const savedProspects: db.Prospect[] = [];

    if (saveResults && results.items) {
      for (const item of results.items) {
        const prospect = db.saveProspect({
          linkedin_id: item.provider_id,
          public_identifier: item.public_identifier,
          full_name: item.full_name,
          first_name: item.first_name,
          last_name: item.last_name,
          headline: item.headline,
          company: item.current_company,
          location: item.location,
          profile_url: item.profile_url,
          picture_url: item.picture_url,
          connection_degree: item.connection_degree,
          source_search: sourceTag,
        });
        savedProspects.push(prospect);
      }
    }

    db.logAction({
      action_type: 'search',
      payload: { args },
      response: { count: results.items?.length || 0 },
      status: 'success',
    });

    return {
      count: results.items?.length || 0,
      saved_count: savedProspects.length,
      source_tag: sourceTag,
      prospects: savedProspects.slice(0, 10).map(p => ({
        id: p.id,
        name: p.full_name,
        headline: p.headline,
        company: p.company,
      })),
      has_more: results.has_more,
      cursor: results.cursor,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    db.logAction({
      action_type: 'search',
      payload: { args },
      status: 'failed',
      error_message: errorMessage,
    });
    throw error;
  }
}

async function handleGetProfile(args: Record<string, unknown>): Promise<unknown> {
  const limitCheck = checkRateLimit('profile_view');
  if (!limitCheck.allowed) {
    return { error: limitCheck.message, rate_limit: limitCheck };
  }

  const accountId = getAccountId();
  const identifier = args.identifier as string;

  try {
    const profile = await unipile.getProfile(accountId, identifier);
    db.incrementRateLimit('profile_view');

    // Save/update in database
    const prospect = db.saveProspect({
      linkedin_id: profile.provider_id,
      public_identifier: profile.public_identifier,
      full_name: profile.full_name,
      first_name: profile.first_name,
      last_name: profile.last_name,
      headline: profile.headline,
      company: profile.current_company,
      location: profile.location,
      profile_url: profile.profile_url,
      picture_url: profile.picture_url,
      connection_degree: profile.connection_degree,
      is_connection: profile.is_connection,
    });

    return {
      prospect_id: prospect.id,
      ...profile,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    db.logAction({
      action_type: 'profile_view',
      payload: { identifier },
      status: 'failed',
      error_message: errorMessage,
    });
    throw error;
  }
}

async function handleSearchCompanies(args: Record<string, unknown>): Promise<unknown> {
  const limitCheck = checkRateLimit('search');
  if (!limitCheck.allowed) {
    return { error: limitCheck.message, rate_limit: limitCheck };
  }

  const accountId = getAccountId();

  try {
    const results = await unipile.searchCompanies(accountId, {
      url: args.url as string | undefined,
      keywords: args.keywords as string | undefined,
      location: args.location as string | undefined,
      industry: args.industry as string | undefined,
      has_job_offers: args.has_job_offers as boolean | undefined,
      company_size: args.company_size as string[] | undefined,
    });

    db.incrementRateLimit('search');

    const limit = (args.limit as number) || 10;
    const companies = results.items.slice(0, limit);

    db.logAction({
      action_type: 'company_search',
      payload: { args },
      response: { count: companies.length },
      status: 'success',
    });

    return {
      count: companies.length,
      companies: companies.map(c => ({
        id: c.id,
        name: c.name,
        industry: c.industry,
        location: c.location,
        employee_count: c.employee_count,
        employee_range: c.employee_range,
        website: c.website,
        description: c.description?.substring(0, 200),
        has_job_offers: c.has_job_offers,
        profile_url: c.profile_url,
      })),
      has_more: results.has_more,
      cursor: results.cursor,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    db.logAction({
      action_type: 'company_search',
      payload: { args },
      status: 'failed',
      error_message: errorMessage,
    });
    throw error;
  }
}

async function handleSearchJobs(args: Record<string, unknown>): Promise<unknown> {
  const limitCheck = checkRateLimit('search');
  if (!limitCheck.allowed) {
    return { error: limitCheck.message, rate_limit: limitCheck };
  }

  const accountId = getAccountId();

  try {
    const results = await unipile.searchJobs(accountId, {
      url: args.url as string | undefined,
      keywords: args.keywords as string | undefined,
      location: args.location as string | undefined,
      company: args.company as string | undefined,
      job_type: args.job_type as 'full_time' | 'part_time' | 'contract' | 'internship' | undefined,
      experience_level: args.experience_level as 'entry' | 'associate' | 'mid_senior' | 'director' | 'executive' | undefined,
      remote: args.remote as boolean | undefined,
      posted_within: args.posted_within as 'day' | 'week' | 'month' | undefined,
    });

    db.incrementRateLimit('search');

    const limit = (args.limit as number) || 10;
    const jobs = results.items.slice(0, limit);

    db.logAction({
      action_type: 'job_search',
      payload: { args },
      response: { count: jobs.length },
      status: 'success',
    });

    return {
      count: jobs.length,
      jobs: jobs.map(j => ({
        id: j.id,
        title: j.title,
        company_name: j.company_name,
        location: j.location,
        job_type: j.job_type,
        experience_level: j.experience_level,
        is_remote: j.is_remote,
        posted_at: j.posted_at,
        applicants_count: j.applicants_count,
        job_url: j.job_url,
        description: j.description?.substring(0, 200),
      })),
      has_more: results.has_more,
      cursor: results.cursor,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    db.logAction({
      action_type: 'job_search',
      payload: { args },
      status: 'failed',
      error_message: errorMessage,
    });
    throw error;
  }
}

async function handleGetCompanyProfile(args: Record<string, unknown>): Promise<unknown> {
  const accountId = getAccountId();
  const identifier = args.identifier as string;

  try {
    const company = await unipile.getCompanyProfile(accountId, identifier);

    return {
      id: company.id,
      name: company.name,
      public_identifier: company.public_identifier,
      industry: company.industry,
      location: company.location,
      headquarters: company.headquarters,
      employee_count: company.employee_count,
      employee_range: company.employee_range,
      website: company.website,
      phone: company.phone,
      description: company.description,
      specialties: company.specialties,
      founded_year: company.founded_year,
      company_type: company.company_type,
      profile_url: company.profile_url,
      logo_url: company.logo_url,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to get company profile: ${errorMessage}`);
  }
}

async function handleGetSearchParameters(args: Record<string, unknown>): Promise<unknown> {
  const accountId = getAccountId();
  const type = args.type as 'LOCATION' | 'INDUSTRY' | 'COMPANY' | 'SCHOOL' | 'SKILL';
  const keywords = args.keywords as string;

  try {
    const params = await unipile.getSearchParameters(accountId, type, keywords);

    return {
      type,
      keywords,
      count: params.length,
      parameters: params.map(p => ({
        id: p.id,
        name: p.name,
        type: p.type,
      })),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to get search parameters: ${errorMessage}`);
  }
}

async function handleGetProspects(args: Record<string, unknown>): Promise<unknown> {
  const prospects = db.getProspects({
    source_search: args.source_search as string | undefined,
    is_connection: args.is_connection as boolean | undefined,
    has_enrollment: args.not_enrolled === true ? false : undefined,
    limit: (args.limit as number) || 50,
  });

  return {
    count: prospects.length,
    prospects: prospects.map(p => ({
      id: p.id,
      linkedin_id: p.linkedin_id,
      name: p.full_name,
      headline: p.headline,
      company: p.company,
      location: p.location,
      is_connection: p.is_connection,
      source_search: p.source_search,
      tags: p.tags,
    })),
  };
}

async function handleSendInvitation(args: Record<string, unknown>): Promise<unknown> {
  const limitCheck = checkRateLimit('invitation');
  if (!limitCheck.allowed) {
    return { error: limitCheck.message, rate_limit: limitCheck };
  }

  const accountId = getAccountId();
  const prospectId = args.prospect_id as string;
  const prospect = db.getProspect(prospectId);

  if (!prospect) {
    throw new Error(`Prospect not found: ${prospectId}`);
  }

  if (prospect.is_connection) {
    return { error: 'Already connected with this person' };
  }

  const message = args.message
    ? personalizeMessage(args.message as string, prospect)
    : undefined;

  try {
    const result = await unipile.sendInvitation(accountId, {
      provider_id: prospect.linkedin_id,
      message,
    });

    db.incrementRateLimit('invitation');

    db.logAction({
      action_type: 'invitation_sent',
      prospect_id: prospectId,
      payload: { message },
      response: { ...result },
      status: result.success ? 'success' : 'failed',
      error_message: result.error,
    });

    return {
      success: result.success,
      prospect_name: prospect.full_name,
      message_sent: message,
      rate_limit: checkRateLimit('invitation'),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    db.logAction({
      action_type: 'invitation_sent',
      prospect_id: prospectId,
      payload: { message },
      status: 'failed',
      error_message: errorMessage,
    });
    throw error;
  }
}

async function handleCheckNewConnections(_args: Record<string, unknown>): Promise<unknown> {
  const accountId = getAccountId();

  try {
    const relations = await unipile.getRelations(accountId);
    const newConnections: Array<{ name: string; linkedin_id: string; enrollment_updated?: boolean }> = [];

    for (const relation of relations.items || []) {
      if (!db.isKnownConnection(relation.provider_id)) {
        db.markAsKnownConnection(relation.provider_id, relation.full_name);

        // Update prospect if exists
        const prospect = db.getProspectByLinkedInId(relation.provider_id);
        if (prospect) {
          db.saveProspect({
            ...prospect,
            is_connection: true,
          });

          // Update any enrollment
          const enrollment = db.getEnrollmentByProspect(prospect.id);
          if (enrollment && enrollment.status === 'in_progress') {
            db.updateEnrollment(enrollment.id, {
              status: 'connected',
              last_action_at: new Date().toISOString(),
            });
            newConnections.push({
              name: relation.full_name,
              linkedin_id: relation.provider_id,
              enrollment_updated: true,
            });
          } else {
            newConnections.push({
              name: relation.full_name,
              linkedin_id: relation.provider_id,
            });
          }
        } else {
          newConnections.push({
            name: relation.full_name,
            linkedin_id: relation.provider_id,
          });
        }
      }
    }

    return {
      new_connections_count: newConnections.length,
      new_connections: newConnections,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to check connections: ${errorMessage}`);
  }
}

async function handleSendMessage(args: Record<string, unknown>): Promise<unknown> {
  const limitCheck = checkRateLimit('message');
  if (!limitCheck.allowed) {
    return { error: limitCheck.message, rate_limit: limitCheck };
  }

  const accountId = getAccountId();
  const prospectId = args.prospect_id as string;
  const prospect = db.getProspect(prospectId);

  if (!prospect) {
    throw new Error(`Prospect not found: ${prospectId}`);
  }

  if (!prospect.is_connection) {
    return { error: 'Cannot message: not connected with this person yet' };
  }

  const message = personalizeMessage(args.message as string, prospect);

  try {
    const result = await unipile.sendMessage(accountId, {
      recipient_id: prospect.linkedin_id,
      text: message,
    });

    db.incrementRateLimit('message');

    db.logAction({
      action_type: 'message_sent',
      prospect_id: prospectId,
      payload: { message },
      response: { ...result },
      status: result.success ? 'success' : 'failed',
      error_message: result.error,
    });

    return {
      success: result.success,
      prospect_name: prospect.full_name,
      message_sent: message,
      rate_limit: checkRateLimit('message'),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    db.logAction({
      action_type: 'message_sent',
      prospect_id: prospectId,
      payload: { message },
      status: 'failed',
      error_message: errorMessage,
    });
    throw error;
  }
}

async function handleCreateSequence(args: Record<string, unknown>): Promise<unknown> {
  const sequence = db.createSequence({
    name: args.name as string,
    description: args.description as string | undefined,
    steps: args.steps as db.SequenceStep[],
  });

  return {
    sequence_id: sequence.id,
    name: sequence.name,
    status: sequence.status,
    steps_count: sequence.steps.length,
  };
}

async function handleListSequences(args: Record<string, unknown>): Promise<unknown> {
  const sequences = db.getSequences(args.status as db.Sequence['status'] | undefined);

  return {
    count: sequences.length,
    sequences: sequences.map(s => ({
      id: s.id,
      name: s.name,
      status: s.status,
      steps_count: s.steps.length,
      created_at: s.created_at,
    })),
  };
}

async function handleActivateSequence(args: Record<string, unknown>): Promise<unknown> {
  const sequenceId = args.sequence_id as string;
  const sequence = db.getSequence(sequenceId);

  if (!sequence) {
    throw new Error(`Sequence not found: ${sequenceId}`);
  }

  db.updateSequenceStatus(sequenceId, 'active');

  return {
    sequence_id: sequenceId,
    name: sequence.name,
    status: 'active',
  };
}

async function handlePauseSequence(args: Record<string, unknown>): Promise<unknown> {
  const sequenceId = args.sequence_id as string;
  const sequence = db.getSequence(sequenceId);

  if (!sequence) {
    throw new Error(`Sequence not found: ${sequenceId}`);
  }

  db.updateSequenceStatus(sequenceId, 'paused');

  return {
    sequence_id: sequenceId,
    name: sequence.name,
    status: 'paused',
  };
}

async function handleEnrollProspects(args: Record<string, unknown>): Promise<unknown> {
  const sequenceId = args.sequence_id as string;
  const sequence = db.getSequence(sequenceId);

  if (!sequence) {
    throw new Error(`Sequence not found: ${sequenceId}`);
  }

  let prospectIds: string[] = [];

  if (args.prospect_ids) {
    prospectIds = args.prospect_ids as string[];
  } else if (args.source_search) {
    const prospects = db.getProspects({
      source_search: args.source_search as string,
      has_enrollment: false,
    });
    prospectIds = prospects.map(p => p.id);
  }

  const enrolled: string[] = [];

  for (const prospectId of prospectIds) {
    const enrollment = db.enrollProspect(sequenceId, prospectId);
    enrolled.push(enrollment.id);
  }

  return {
    sequence_id: sequenceId,
    sequence_name: sequence.name,
    enrolled_count: enrolled.length,
    enrollment_ids: enrolled.slice(0, 10),
  };
}

async function handleRunSequenceActions(args: Record<string, unknown>): Promise<unknown> {
  const maxActions = (args.max_actions as number) || 10;
  const sequenceId = args.sequence_id as string | undefined;

  // Get enrollments due for action
  const enrollments = db.getEnrollments({
    sequence_id: sequenceId,
    due_for_action: true,
    limit: maxActions,
  });

  const results: Array<{
    enrollment_id: string;
    prospect_name: string;
    action: string;
    success: boolean;
    error?: string;
  }> = [];

  for (const enrollment of enrollments) {
    const prospect = db.getProspect(enrollment.prospect_id);
    const sequence = db.getSequence(enrollment.sequence_id);

    if (!prospect || !sequence) continue;

    const step = sequence.steps[enrollment.current_step];
    if (!step) {
      db.updateEnrollment(enrollment.id, { status: 'completed' });
      continue;
    }

    let success = false;
    let error: string | undefined;

    try {
      switch (step.type) {
        case 'visit_profile': {
          const limitCheck = checkRateLimit('profile_view');
          if (!limitCheck.allowed) {
            error = limitCheck.message;
            break;
          }

          // Get profile to trigger a "view" on LinkedIn
          const profileResult = await handleGetProfile({
            identifier: prospect.linkedin_id || prospect.public_identifier || prospect.id,
          }) as { success?: boolean; error?: string };

          success = !profileResult.error;
          error = profileResult.error;

          if (success) {
            const nextStep = enrollment.current_step + 1;
            db.updateEnrollment(enrollment.id, {
              current_step: nextStep,
              status: 'in_progress',
              last_action_at: new Date().toISOString(),
              next_action_at: step.delay_days
                ? new Date(Date.now() + step.delay_days * 24 * 60 * 60 * 1000).toISOString()
                : new Date().toISOString(),
            });

            // Log the profile view
            db.logAction({
              enrollment_id: enrollment.id,
              prospect_id: prospect.id,
              action_type: 'profile_view',
              step_index: enrollment.current_step,
              status: 'success',
            });
          }
          break;
        }

        case 'send_invitation': {
          const limitCheck = checkRateLimit('invitation');
          if (!limitCheck.allowed) {
            error = limitCheck.message;
            break;
          }

          const result = await handleSendInvitation({
            prospect_id: prospect.id,
            message: step.message,
          }) as { success?: boolean; error?: string };

          success = result.success === true;
          error = result.error;

          if (success) {
            db.updateEnrollment(enrollment.id, {
              current_step: enrollment.current_step + 1,
              status: 'in_progress',
              last_action_at: new Date().toISOString(),
              next_action_at: step.delay_days
                ? new Date(Date.now() + step.delay_days * 24 * 60 * 60 * 1000).toISOString()
                : new Date().toISOString(),
            });
          }
          break;
        }

        case 'wait_for_acceptance': {
          // Check if already connected
          if (prospect.is_connection) {
            success = true;
            db.updateEnrollment(enrollment.id, {
              current_step: enrollment.current_step + 1,
              status: 'connected',
              last_action_at: new Date().toISOString(),
            });
          } else {
            // Check timeout
            const enrolledAt = new Date(enrollment.created_at).getTime();
            const timeoutMs = (step.timeout_days || 7) * 24 * 60 * 60 * 1000;

            if (Date.now() - enrolledAt > timeoutMs) {
              error = 'Timeout waiting for acceptance';
              db.updateEnrollment(enrollment.id, { status: 'failed', error_message: error });
            } else {
              // Still waiting, reschedule check
              db.updateEnrollment(enrollment.id, {
                next_action_at: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(), // Check again in 8 hours
              });
              success = true; // Not failed, just waiting
            }
          }
          break;
        }

        case 'send_message':
        case 'send_followup': {
          const limitCheck = checkRateLimit('message');
          if (!limitCheck.allowed) {
            error = limitCheck.message;
            break;
          }

          if (!prospect.is_connection) {
            error = 'Not connected yet';
            break;
          }

          const result = await handleSendMessage({
            prospect_id: prospect.id,
            message: step.message || 'Thanks for connecting!',
          }) as { success?: boolean; error?: string };

          success = result.success === true;
          error = result.error;

          if (success) {
            const nextStep = enrollment.current_step + 1;
            const isComplete = nextStep >= sequence.steps.length;

            db.updateEnrollment(enrollment.id, {
              current_step: nextStep,
              status: isComplete ? 'completed' : 'in_progress',
              last_action_at: new Date().toISOString(),
              next_action_at: !isComplete && step.delay_days
                ? new Date(Date.now() + step.delay_days * 24 * 60 * 60 * 1000).toISOString()
                : undefined,
            });
          }
          break;
        }

        case 'delay': {
          // Just advance to next step after delay
          const nextStep = enrollment.current_step + 1;
          db.updateEnrollment(enrollment.id, {
            current_step: nextStep,
            next_action_at: step.delay_days
              ? new Date(Date.now() + step.delay_days * 24 * 60 * 60 * 1000).toISOString()
              : new Date().toISOString(),
          });
          success = true;
          break;
        }

        default:
          error = `Unknown step type: ${step.type}`;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    results.push({
      enrollment_id: enrollment.id,
      prospect_name: prospect.full_name,
      action: step.type,
      success,
      error,
    });
  }

  return {
    actions_run: results.length,
    results,
    rate_limits: {
      invitation: checkRateLimit('invitation'),
      message: checkRateLimit('message'),
    },
  };
}

async function handleGetSequenceStatus(args: Record<string, unknown>): Promise<unknown> {
  const sequenceId = args.sequence_id as string;
  const sequence = db.getSequence(sequenceId);

  if (!sequence) {
    throw new Error(`Sequence not found: ${sequenceId}`);
  }

  const enrollments = db.getEnrollments({ sequence_id: sequenceId });

  const statusCounts: Record<string, number> = {};
  for (const e of enrollments) {
    statusCounts[e.status] = (statusCounts[e.status] || 0) + 1;
  }

  return {
    sequence_id: sequenceId,
    name: sequence.name,
    status: sequence.status,
    total_enrolled: enrollments.length,
    by_status: statusCounts,
    steps: sequence.steps.map((s, i) => ({
      index: i,
      type: s.type,
      message_preview: s.message?.substring(0, 50),
    })),
  };
}

async function handleGetDailyLimits(_args: Record<string, unknown>): Promise<unknown> {
  return {
    invitation: {
      used_today: db.getRateLimitCount('invitation'),
      limit_daily: RATE_LIMITS.invitation.daily,
      used_this_week: db.getWeeklyRateLimitCount('invitation'),
      limit_weekly: RATE_LIMITS.invitation.weekly,
    },
    message: {
      used_today: db.getRateLimitCount('message'),
      limit_daily: RATE_LIMITS.message.daily,
    },
    profile_view: {
      used_today: db.getRateLimitCount('profile_view'),
      limit_daily: RATE_LIMITS.profile_view.daily,
    },
    search: {
      used_today: db.getRateLimitCount('search'),
      limit_daily: RATE_LIMITS.search.daily,
    },
    post_action: {
      used_today: db.getRateLimitCount('post_action'),
      limit_daily: RATE_LIMITS.post_action.daily,
    },
    inmail: {
      used_today: db.getRateLimitCount('inmail'),
      limit_daily: RATE_LIMITS.inmail.daily,
    },
  };
}

async function handleGetActionHistory(args: Record<string, unknown>): Promise<unknown> {
  const actions = db.getRecentActions(
    args.action_type as string | undefined,
    (args.limit as number) || 50
  );

  return {
    count: actions.length,
    actions: actions.map(a => ({
      id: a.id,
      type: a.action_type,
      status: a.status,
      error: a.error_message,
      created_at: a.created_at,
    })),
  };
}

async function handleGetChats(args: Record<string, unknown>): Promise<unknown> {
  const accountId = getAccountId();
  const result = await unipile.getChats(accountId);

  const limit = (args.limit as number) || 20;
  const chats = result.items.slice(0, limit);

  return {
    count: chats.length,
    chats: chats.map(c => ({
      id: c.id,
      participant_name: c.participant_name,
      participant_id: c.participant_id,
      last_message: c.last_message?.substring(0, 100),
      last_message_at: c.last_message_at,
      unread_count: c.unread_count || 0,
    })),
  };
}

async function handleGetChatMessages(args: Record<string, unknown>): Promise<unknown> {
  const accountId = getAccountId();
  const chatId = args.chat_id as string;

  if (!chatId) {
    throw new Error('chat_id is required');
  }

  const result = await unipile.getChatMessages(accountId, chatId);

  const limit = (args.limit as number) || 20;
  const messages = result.items.slice(0, limit);

  return {
    chat_id: chatId,
    count: messages.length,
    messages: messages.map(m => ({
      id: m.id,
      sender_name: m.sender_name,
      text: m.text,
      sent_at: m.sent_at,
      is_outgoing: m.is_outgoing,
    })),
  };
}

async function handleSearchPosts(args: Record<string, unknown>): Promise<unknown> {
  const limitCheck = checkRateLimit('search');
  if (!limitCheck.allowed) {
    return { error: limitCheck.message, rate_limit: limitCheck };
  }

  const accountId = getAccountId();

  try {
    const results = await unipile.searchPosts(accountId, {
      url: args.url as string | undefined,
      keywords: args.keywords as string | undefined,
      posted_within: args.posted_within as 'past_24h' | 'past_week' | 'past_month' | undefined,
      sort_by: args.sort_by as 'relevance' | 'date_posted' | undefined,
      from_member: args.from_member as string[] | undefined,
      from_company: args.from_company as string[] | undefined,
      mentions_member: args.mentions_member as string[] | undefined,
      mentions_company: args.mentions_company as string[] | undefined,
      cursor: args.cursor as string | undefined,
    });

    db.incrementRateLimit('search');

    const limit = (args.limit as number) || 10;
    const posts = results.items.slice(0, limit);

    db.logAction({
      action_type: 'post_search',
      payload: { args },
      response: { count: posts.length },
      status: 'success',
    });

    return {
      count: posts.length,
      posts: posts.map(p => ({
        social_id: p.social_id,
        type: p.type,
        share_url: p.share_url,
        text: p.text,
        date: p.date,
        parsed_datetime: p.parsed_datetime,
        reaction_count: p.reaction_count,
        comment_count: p.comment_count,
        repost_count: p.repost_count,
        impressions_count: p.impressions_count,
        is_repost: p.is_repost,
        author: p.author ? {
          id: p.author.id,
          public_identifier: p.author.public_identifier,
          name: p.author.name,
          headline: p.author.headline,
          is_company: p.author.is_company,
        } : undefined,
      })),
      has_more: results.has_more,
      cursor: results.cursor,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    db.logAction({
      action_type: 'post_search',
      payload: { args },
      status: 'failed',
      error_message: errorMessage,
    });
    throw error;
  }
}

async function handleGetUserPosts(args: Record<string, unknown>): Promise<unknown> {
  const accountId = getAccountId();
  const userId = args.user_id as string;

  if (!userId) {
    throw new Error('user_id is required');
  }

  const result = await unipile.getUserPosts(accountId, userId);

  const limit = (args.limit as number) || 10;
  const posts = result.items.slice(0, limit);

  return {
    user_id: userId,
    count: posts.length,
    posts: posts.map(p => ({
      id: p.id,
      social_id: p.social_id,
      author_name: p.author_name,
      text: p.text?.substring(0, 500),
      posted_at: p.posted_at,
      likes_count: p.likes_count || 0,
      comments_count: p.comments_count || 0,
      shares_count: p.shares_count || 0,
    })),
  };
}

async function handleGetPost(args: Record<string, unknown>): Promise<unknown> {
  const accountId = getAccountId();
  const postId = args.post_id as string;

  if (!postId) {
    throw new Error('post_id is required');
  }

  const post = await unipile.getPost(accountId, postId);

  return {
    id: post.id,
    social_id: post.social_id,
    author_id: post.author_id,
    author_name: post.author_name,
    text: post.text,
    posted_at: post.posted_at,
    likes_count: post.likes_count || 0,
    comments_count: post.comments_count || 0,
    shares_count: post.shares_count || 0,
  };
}

async function handleCreatePost(args: Record<string, unknown>): Promise<unknown> {
  const limitCheck = checkRateLimit('post_action');
  if (!limitCheck.allowed) {
    return { error: limitCheck.message, rate_limit: limitCheck };
  }

  const accountId = getAccountId();
  const text = args.text as string;

  if (!text) {
    throw new Error('text is required');
  }

  try {
    const result = await unipile.createPost(accountId, { text });

    db.incrementRateLimit('post_action');

    db.logAction({
      action_type: 'post_created',
      payload: { text: text.substring(0, 100) },
      response: { ...result },
      status: result.success ? 'success' : 'failed',
      error_message: result.error,
    });

    return {
      success: result.success,
      post_id: result.post_id,
      social_id: result.social_id,
      text_preview: text.substring(0, 100),
      rate_limit: checkRateLimit('post_action'),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    db.logAction({
      action_type: 'post_created',
      payload: { text: text.substring(0, 100) },
      status: 'failed',
      error_message: errorMessage,
    });
    throw error;
  }
}

async function handleGetProfileViewers(args: Record<string, unknown>): Promise<unknown> {
  const accountId = getAccountId();
  const limit = (args.limit as number) || 20;
  const saveAsProspects = args.save_as_prospects !== false;
  const sourceTag = (args.source_tag as string) || 'profile_viewers';

  try {
    const result = await unipile.getProfileViewers(accountId);
    const viewers = result.items.slice(0, limit);

    const savedProspects: db.Prospect[] = [];

    if (saveAsProspects) {
      for (const viewer of viewers) {
        if (viewer.provider_id) {
          const prospect = db.saveProspect({
            linkedin_id: viewer.provider_id,
            public_identifier: viewer.public_identifier,
            full_name: viewer.full_name,
            headline: viewer.headline,
            picture_url: viewer.picture_url,
            source_search: sourceTag,
          });
          savedProspects.push(prospect);
        }
      }
    }

    db.logAction({
      action_type: 'profile_viewers_fetched',
      payload: { limit, save_as_prospects: saveAsProspects },
      response: { count: viewers.length, saved: savedProspects.length },
      status: 'success',
    });

    return {
      count: viewers.length,
      saved_count: savedProspects.length,
      source_tag: saveAsProspects ? sourceTag : null,
      viewers: viewers.map(v => ({
        id: v.id,
        provider_id: v.provider_id,
        name: v.full_name,
        headline: v.headline,
        viewed_at: v.viewed_at,
        prospect_id: savedProspects.find(p => p.linkedin_id === v.provider_id)?.id,
      })),
      has_more: result.has_more,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    db.logAction({
      action_type: 'profile_viewers_fetched',
      payload: { limit },
      status: 'failed',
      error_message: errorMessage,
    });
    throw error;
  }
}

async function handleSendInMail(args: Record<string, unknown>): Promise<unknown> {
  const limitCheck = checkRateLimit('inmail');
  if (!limitCheck.allowed) {
    return { error: limitCheck.message, rate_limit: limitCheck };
  }

  const accountId = getAccountId();
  const prospectId = args.prospect_id as string;
  const prospect = db.getProspect(prospectId);

  if (!prospect) {
    throw new Error(`Prospect not found: ${prospectId}`);
  }

  const subject = args.subject as string;
  const message = personalizeMessage(args.message as string, prospect);

  try {
    const result = await unipile.sendInMail(accountId, {
      recipient_id: prospect.linkedin_id,
      subject,
      text: message,
    });

    db.incrementRateLimit('inmail');

    db.logAction({
      action_type: 'inmail_sent',
      prospect_id: prospectId,
      payload: { subject, message: message.substring(0, 100) },
      response: { ...result },
      status: result.success ? 'success' : 'failed',
      error_message: result.error,
    });

    return {
      success: result.success,
      prospect_name: prospect.full_name,
      subject,
      message_preview: message.substring(0, 100),
      credits_remaining: result.credits_remaining,
      rate_limit: checkRateLimit('inmail'),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    db.logAction({
      action_type: 'inmail_sent',
      prospect_id: prospectId,
      payload: { subject, message: message.substring(0, 100) },
      status: 'failed',
      error_message: errorMessage,
    });
    throw error;
  }
}

async function handleCheckInMailStatus(args: Record<string, unknown>): Promise<unknown> {
  const accountId = getAccountId();
  const prospectId = args.prospect_id as string;
  const prospect = db.getProspect(prospectId);

  if (!prospect) {
    throw new Error(`Prospect not found: ${prospectId}`);
  }

  try {
    const status = await unipile.checkInMailStatus(accountId, prospect.linkedin_id);

    return {
      prospect_id: prospectId,
      prospect_name: prospect.full_name,
      can_send_inmail: status.can_send_inmail,
      is_open_profile: status.is_open_profile,
      inmail_credits_required: status.inmail_credits_required,
      recommendation: status.is_open_profile
        ? 'Open profile - free InMail available!'
        : status.can_send_inmail
          ? 'Can send InMail (1 credit required)'
          : 'InMail not available for this profile',
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // If Sales Navigator is not available, return a helpful message
    if (errorMessage.includes('403') || errorMessage.includes('unauthorized')) {
      return {
        prospect_id: prospectId,
        prospect_name: prospect.full_name,
        error: 'Sales Navigator or Recruiter subscription required for InMail status check',
        can_send_inmail: null,
        is_open_profile: null,
      };
    }
    throw error;
  }
}

// Tool dispatcher
const toolHandlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  search_linkedin: handleSearchLinkedin,
  search_companies: handleSearchCompanies,
  search_jobs: handleSearchJobs,
  search_posts: handleSearchPosts,
  get_profile: handleGetProfile,
  get_company_profile: handleGetCompanyProfile,
  get_search_parameters: handleGetSearchParameters,
  get_prospects: handleGetProspects,
  update_prospect: async (args) => {
    const prospect = db.getProspect(args.prospect_id as string);
    if (!prospect) throw new Error('Prospect not found');
    // Update via saveProspect
    return db.saveProspect({
      ...prospect,
      tags: args.tags as string[] | undefined ?? prospect.tags,
      notes: args.notes as string | undefined ?? prospect.notes,
    });
  },
  send_invitation: handleSendInvitation,
  check_new_connections: handleCheckNewConnections,
  // list_sent_invitations removed - endpoint not available
  send_message: handleSendMessage,
  create_sequence: handleCreateSequence,
  list_sequences: handleListSequences,
  activate_sequence: handleActivateSequence,
  pause_sequence: handlePauseSequence,
  enroll_prospects: handleEnrollProspects,
  run_sequence_actions: handleRunSequenceActions,
  get_sequence_status: handleGetSequenceStatus,
  get_daily_limits: handleGetDailyLimits,
  get_action_history: handleGetActionHistory,
  get_chats: handleGetChats,
  get_chat_messages: handleGetChatMessages,
  get_user_posts: handleGetUserPosts,
  get_post: handleGetPost,
  create_post: handleCreatePost,
  get_profile_viewers: handleGetProfileViewers,
  send_inmail: handleSendInMail,
  check_inmail_status: handleCheckInMailStatus,
};

// ============ MCP Server Setup ============

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const handler = toolHandlers[name];
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }

  // Check if Unipile is configured
  if (!unipile.isConfigured()) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'Unipile not configured. Set UNIPILE_API_KEY and UNIPILE_DSN environment variables.',
          }),
        },
      ],
    };
  }

  try {
    const result = await handler(args || {});
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
          text: JSON.stringify({ error: errorMessage }),
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('LinkedIn Outreach MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
