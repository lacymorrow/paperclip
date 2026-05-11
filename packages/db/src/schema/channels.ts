import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const channels = pgTable(
  "channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    name: text("name").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("active"),
    direction: text("direction").notNull().default("outbound"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("channels_company_status_idx").on(table.companyId, table.status),
    companyPlatformIdx: index("channels_company_platform_idx").on(table.companyId, table.platform),
  }),
);

export const channelMessages = pgTable(
  "channel_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
    direction: text("direction").notNull(),
    content: text("content").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyChannelIdx: index("channel_messages_company_channel_idx").on(table.companyId, table.channelId),
    companyDirectionIdx: index("channel_messages_company_direction_idx").on(table.companyId, table.direction),
    companyStatusIdx: index("channel_messages_company_status_idx").on(table.companyId, table.status),
    issueIdx: index("channel_messages_issue_idx").on(table.issueId),
  }),
);

export const channelRoutes = pgTable(
  "channel_routes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
    trigger: text("trigger").notNull(),
    filter: jsonb("filter").$type<Record<string, unknown>>(),
    template: text("template"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyChannelIdx: index("channel_routes_company_channel_idx").on(table.companyId, table.channelId),
    companyEnabledIdx: index("channel_routes_company_enabled_idx").on(table.companyId, table.enabled),
  }),
);
