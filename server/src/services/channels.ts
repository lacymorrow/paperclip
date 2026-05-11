import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { channels, channelMessages, channelRoutes } from "@paperclipai/db";
import type {
  Channel,
  ChannelMessage,
  ChannelRoute,
  CreateChannel,
  CreateChannelRoute,
  ListChannelMessagesQuery,
  UpdateChannel,
  UpdateChannelRoute,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";

function rowToChannel(row: typeof channels.$inferSelect): Channel {
  return {
    id: row.id,
    companyId: row.companyId,
    platform: row.platform as Channel["platform"],
    name: row.name,
    config: row.config as Record<string, unknown>,
    status: row.status as Channel["status"],
    direction: row.direction as Channel["direction"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToRoute(row: typeof channelRoutes.$inferSelect): ChannelRoute {
  return {
    id: row.id,
    companyId: row.companyId,
    channelId: row.channelId,
    trigger: row.trigger,
    filter: row.filter as Record<string, unknown> | null,
    template: row.template,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
  };
}

function rowToMessage(row: typeof channelMessages.$inferSelect): ChannelMessage {
  return {
    id: row.id,
    companyId: row.companyId,
    channelId: row.channelId,
    direction: row.direction as ChannelMessage["direction"],
    content: row.content,
    metadata: row.metadata as Record<string, unknown>,
    issueId: row.issueId,
    agentId: row.agentId,
    status: row.status as ChannelMessage["status"],
    createdAt: row.createdAt.toISOString(),
  };
}

export function channelService(db: Db) {
  async function listChannels(companyId: string): Promise<Channel[]> {
    const rows = await db
      .select()
      .from(channels)
      .where(eq(channels.companyId, companyId))
      .orderBy(desc(channels.createdAt));
    return rows.map(rowToChannel);
  }

  async function getChannel(id: string): Promise<Channel | null> {
    const rows = await db.select().from(channels).where(eq(channels.id, id));
    return rows[0] ? rowToChannel(rows[0]) : null;
  }

  async function createChannel(companyId: string, input: CreateChannel): Promise<Channel> {
    const rows = await db
      .insert(channels)
      .values({
        companyId,
        platform: input.platform,
        name: input.name,
        config: input.config ?? {},
        status: input.status ?? "active",
        direction: input.direction ?? "outbound",
      })
      .returning();
    return rowToChannel(rows[0]);
  }

  async function updateChannel(id: string, input: UpdateChannel): Promise<Channel> {
    const existing = await getChannel(id);
    if (!existing) throw notFound("Channel not found");
    const rows = await db
      .update(channels)
      .set({
        ...(input.platform !== undefined && { platform: input.platform }),
        ...(input.name !== undefined && { name: input.name }),
        ...(input.config !== undefined && { config: input.config }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.direction !== undefined && { direction: input.direction }),
        updatedAt: new Date(),
      })
      .where(eq(channels.id, id))
      .returning();
    return rowToChannel(rows[0]);
  }

  async function deleteChannel(id: string): Promise<void> {
    const result = await db.delete(channels).where(eq(channels.id, id)).returning({ id: channels.id });
    if (result.length === 0) throw notFound("Channel not found");
  }

  async function listRoutes(companyId: string, channelId?: string): Promise<ChannelRoute[]> {
    const conditions = [eq(channelRoutes.companyId, companyId)];
    if (channelId) conditions.push(eq(channelRoutes.channelId, channelId));
    const rows = await db
      .select()
      .from(channelRoutes)
      .where(and(...conditions))
      .orderBy(desc(channelRoutes.createdAt));
    return rows.map(rowToRoute);
  }

  async function getRoute(id: string): Promise<ChannelRoute | null> {
    const rows = await db.select().from(channelRoutes).where(eq(channelRoutes.id, id));
    return rows[0] ? rowToRoute(rows[0]) : null;
  }

  async function createRoute(companyId: string, input: CreateChannelRoute): Promise<ChannelRoute> {
    const channel = await getChannel(input.channelId);
    if (!channel || channel.companyId !== companyId) throw notFound("Channel not found");
    const rows = await db
      .insert(channelRoutes)
      .values({
        companyId,
        channelId: input.channelId,
        trigger: input.trigger,
        filter: input.filter ?? null,
        template: input.template ?? null,
        enabled: input.enabled ?? true,
      })
      .returning();
    return rowToRoute(rows[0]);
  }

  async function updateRoute(id: string, input: UpdateChannelRoute): Promise<ChannelRoute> {
    const existing = await getRoute(id);
    if (!existing) throw notFound("Channel route not found");
    const rows = await db
      .update(channelRoutes)
      .set({
        ...(input.trigger !== undefined && { trigger: input.trigger }),
        ...(input.filter !== undefined && { filter: input.filter }),
        ...(input.template !== undefined && { template: input.template }),
        ...(input.enabled !== undefined && { enabled: input.enabled }),
      })
      .where(eq(channelRoutes.id, id))
      .returning();
    return rowToRoute(rows[0]);
  }

  async function deleteRoute(id: string): Promise<void> {
    const result = await db.delete(channelRoutes).where(eq(channelRoutes.id, id)).returning({ id: channelRoutes.id });
    if (result.length === 0) throw notFound("Channel route not found");
  }

  async function listMessages(companyId: string, query: ListChannelMessagesQuery): Promise<ChannelMessage[]> {
    const conditions = [eq(channelMessages.companyId, companyId)];
    if (query.channelId) conditions.push(eq(channelMessages.channelId, query.channelId));
    if (query.direction) conditions.push(eq(channelMessages.direction, query.direction));
    if (query.status) conditions.push(eq(channelMessages.status, query.status));
    const rows = await db
      .select()
      .from(channelMessages)
      .where(and(...conditions))
      .orderBy(desc(channelMessages.createdAt))
      .limit(query.limit ?? 50)
      .offset(query.offset ?? 0);
    return rows.map(rowToMessage);
  }

  return {
    listChannels,
    getChannel,
    createChannel,
    updateChannel,
    deleteChannel,
    listRoutes,
    getRoute,
    createRoute,
    updateRoute,
    deleteRoute,
    listMessages,
  };
}
