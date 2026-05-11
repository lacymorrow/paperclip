import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createChannelSchema,
  createChannelRouteSchema,
  listChannelMessagesQuerySchema,
  updateChannelSchema,
  updateChannelRouteSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { channelService } from "../services/channels.js";
import { assertCompanyAccess } from "./authz.js";

export function channelRoutes(db: Db) {
  const router = Router();
  const svc = channelService(db);

  // Channels CRUD
  router.get("/companies/:companyId/channels", async (req, res) => {
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(req, companyId);
    const result = await svc.listChannels(companyId);
    res.json(result);
  });

  router.post("/companies/:companyId/channels", validate(createChannelSchema), async (req, res) => {
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(req, companyId);
    const created = await svc.createChannel(companyId, req.body);
    res.status(201).json(created);
  });

  router.get("/channels/:id", async (req, res) => {
    const channel = await svc.getChannel(req.params.id as string);
    if (!channel) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    assertCompanyAccess(req, channel.companyId);
    res.json(channel);
  });

  router.patch("/channels/:id", validate(updateChannelSchema), async (req, res) => {
    const channel = await svc.getChannel(req.params.id as string);
    if (!channel) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    assertCompanyAccess(req, channel.companyId);
    const updated = await svc.updateChannel(channel.id, req.body);
    res.json(updated);
  });

  router.delete("/channels/:id", async (req, res) => {
    const channel = await svc.getChannel(req.params.id as string);
    if (!channel) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    assertCompanyAccess(req, channel.companyId);
    await svc.deleteChannel(channel.id);
    res.status(204).send();
  });

  // Routes CRUD
  router.get("/companies/:companyId/routes", async (req, res) => {
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(req, companyId);
    const channelId = typeof req.query.channelId === "string" ? req.query.channelId : undefined;
    const result = await svc.listRoutes(companyId, channelId);
    res.json(result);
  });

  router.post("/companies/:companyId/routes", validate(createChannelRouteSchema), async (req, res) => {
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(req, companyId);
    const created = await svc.createRoute(companyId, req.body);
    res.status(201).json(created);
  });

  router.patch("/routes/:id", validate(updateChannelRouteSchema), async (req, res) => {
    const route = await svc.getRoute(req.params.id as string);
    if (!route) {
      res.status(404).json({ error: "Channel route not found" });
      return;
    }
    assertCompanyAccess(req, route.companyId);
    const updated = await svc.updateRoute(route.id, req.body);
    res.json(updated);
  });

  router.delete("/routes/:id", async (req, res) => {
    const route = await svc.getRoute(req.params.id as string);
    if (!route) {
      res.status(404).json({ error: "Channel route not found" });
      return;
    }
    assertCompanyAccess(req, route.companyId);
    await svc.deleteRoute(route.id);
    res.status(204).send();
  });

  // Messages list
  router.get("/companies/:companyId/messages", async (req, res) => {
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(req, companyId);
    const parseResult = listChannelMessagesQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      res.status(400).json({ error: "Invalid query parameters", details: parseResult.error.flatten() });
      return;
    }
    const result = await svc.listMessages(companyId, parseResult.data);
    res.json(result);
  });

  return router;
}
