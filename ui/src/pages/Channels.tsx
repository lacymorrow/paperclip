import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Plus, Radio, RefreshCw, Send, Trash2, XCircle } from "lucide-react";
import {
  CHANNEL_DIRECTIONS,
  type Channel,
  type ChannelDirection,
  type ChannelPlatform,
  type CreateChannel,
  type CreateChannelRoute,
} from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { channelsApi, channelRoutesApi } from "../api/channels";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

const PLATFORM_LABELS: Record<ChannelPlatform, string> = {
  slack: "Slack",
  discord: "Discord",
  telegram: "Telegram",
  email: "Email",
  webhook: "Webhook",
};

const DIRECTION_LABELS: Record<ChannelDirection, string> = {
  outbound: "Outbound",
  inbound: "Inbound",
  bidirectional: "Bidirectional",
};

const SUPPORTED_PLATFORMS: ChannelPlatform[] = ["slack", "webhook"];

function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform as ChannelPlatform] ?? platform;
}

function statusTone(status: Channel["status"]): "ok" | "warn" | "error" {
  if (status === "active") return "ok";
  if (status === "disconnected") return "warn";
  return "error";
}

function StatusBadge({ status }: { status: Channel["status"] }) {
  const tone = statusTone(status);
  const color =
    tone === "ok"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      : tone === "warn"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
        : "border-destructive/30 bg-destructive/10 text-destructive";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${color}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${tone === "ok" ? "bg-emerald-500" : tone === "warn" ? "bg-amber-500" : "bg-destructive"}`} />
      {status}
    </span>
  );
}

interface AddChannelFormState {
  platform: ChannelPlatform;
  name: string;
  direction: ChannelDirection;
  slackBotToken: string;
  slackChannelId: string;
  webhookUrl: string;
  webhookSigningSecret: string;
}

const EMPTY_CHANNEL_FORM: AddChannelFormState = {
  platform: "slack",
  name: "",
  direction: "outbound",
  slackBotToken: "",
  slackChannelId: "",
  webhookUrl: "",
  webhookSigningSecret: "",
};

function buildChannelConfig(form: AddChannelFormState): Record<string, unknown> {
  if (form.platform === "slack") {
    const config: Record<string, unknown> = {};
    if (form.slackBotToken.trim()) config.botToken = form.slackBotToken.trim();
    if (form.slackChannelId.trim()) config.slackChannelId = form.slackChannelId.trim();
    return config;
  }
  if (form.platform === "webhook") {
    const config: Record<string, unknown> = {};
    if (form.webhookUrl.trim()) config.webhookUrl = form.webhookUrl.trim();
    if (form.webhookSigningSecret.trim()) config.signingSecret = form.webhookSigningSecret.trim();
    return config;
  }
  return {};
}

function validateChannelForm(form: AddChannelFormState): string | null {
  if (!form.name.trim()) return "Name is required";
  if (form.platform === "slack" && !form.slackBotToken.trim()) {
    return "Slack bot token is required";
  }
  if (form.platform === "webhook" && !form.webhookUrl.trim()) {
    return "Webhook URL is required";
  }
  return null;
}

interface AddRouteFormState {
  channelId: string;
  trigger: string;
  template: string;
  enabled: boolean;
}

const EMPTY_ROUTE_FORM: AddRouteFormState = {
  channelId: "",
  trigger: "",
  template: "",
  enabled: true,
};

export function Channels() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();

  const [isAddChannelOpen, setIsAddChannelOpen] = useState(false);
  const [channelForm, setChannelForm] = useState<AddChannelFormState>(EMPTY_CHANNEL_FORM);
  const [channelFormError, setChannelFormError] = useState<string | null>(null);
  const [isAddRouteOpen, setIsAddRouteOpen] = useState(false);
  const [routeForm, setRouteForm] = useState<AddRouteFormState>(EMPTY_ROUTE_FORM);
  const [routeFormError, setRouteFormError] = useState<string | null>(null);
  const [testingChannelId, setTestingChannelId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Channels" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const channelsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.channels.list(selectedCompanyId)
      : (["channels", "__disabled__"] as const),
    queryFn: () => channelsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const routesQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.channels.routes(selectedCompanyId)
      : (["channels", "routes", "__disabled__"] as const),
    queryFn: () => channelRoutesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const channelsById = useMemo(() => {
    const map = new Map<string, Channel>();
    for (const c of channelsQuery.data ?? []) map.set(c.id, c);
    return map;
  }, [channelsQuery.data]);

  const createChannelMutation = useMutation({
    mutationFn: (data: CreateChannel) => channelsApi.create(selectedCompanyId!, data),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.channels.list(selectedCompanyId!),
      });
      setIsAddChannelOpen(false);
      setChannelForm(EMPTY_CHANNEL_FORM);
      setChannelFormError(null);
      pushToast({ title: "Channel added", tone: "success" });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "Failed to add channel";
      setChannelFormError(message);
    },
  });

  const deleteChannelMutation = useMutation({
    mutationFn: (id: string) => channelsApi.remove(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.channels.list(selectedCompanyId!),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.channels.routes(selectedCompanyId!),
      });
      pushToast({ title: "Channel deleted", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to delete channel",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const testChannelMutation = useMutation({
    mutationFn: (id: string) => channelsApi.test(id),
    onMutate: (id) => {
      setTestingChannelId(id);
    },
    onSettled: () => {
      setTestingChannelId(null);
    },
    onSuccess: (result) => {
      if (result.delivered) {
        pushToast({ title: "Test message delivered", tone: "success" });
      } else {
        pushToast({
          title: "Test message failed",
          body: result.error ?? "The channel did not deliver the test message.",
          tone: "error",
        });
      }
    },
    onError: (error) => {
      // Failed sends come back as 502 with a JSON body; surface its error text.
      let body =
        error instanceof Error ? error.message : "Unknown error";
      if (error instanceof ApiError) {
        const apiBody = error.body as { error?: string } | null;
        if (apiBody?.error) body = apiBody.error;
        else if (error.status === 404) body = "Channel not found.";
      }
      pushToast({ title: "Test message failed", body, tone: "error" });
    },
  });

  const createRouteMutation = useMutation({
    mutationFn: (data: CreateChannelRoute) => channelRoutesApi.create(selectedCompanyId!, data),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.channels.routes(selectedCompanyId!),
      });
      setIsAddRouteOpen(false);
      setRouteForm(EMPTY_ROUTE_FORM);
      setRouteFormError(null);
      pushToast({ title: "Route added", tone: "success" });
    },
    onError: (error) => {
      setRouteFormError(error instanceof Error ? error.message : "Failed to add route");
    },
  });

  const toggleRouteMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      channelRoutesApi.update(id, { enabled }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.channels.routes(selectedCompanyId!),
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update route",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const deleteRouteMutation = useMutation({
    mutationFn: (id: string) => channelRoutesApi.remove(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.channels.routes(selectedCompanyId!),
      });
      pushToast({ title: "Route deleted", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to delete route",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  function submitChannelForm() {
    const validationError = validateChannelForm(channelForm);
    if (validationError) {
      setChannelFormError(validationError);
      return;
    }
    setChannelFormError(null);
    createChannelMutation.mutate({
      platform: channelForm.platform,
      name: channelForm.name.trim(),
      direction: channelForm.direction,
      config: buildChannelConfig(channelForm),
      status: "active",
    });
  }

  function submitRouteForm() {
    if (!routeForm.channelId) {
      setRouteFormError("Pick a channel");
      return;
    }
    if (!routeForm.trigger.trim()) {
      setRouteFormError("Trigger is required");
      return;
    }
    setRouteFormError(null);
    createRouteMutation.mutate({
      channelId: routeForm.channelId,
      trigger: routeForm.trigger.trim(),
      template: routeForm.template.trim() || null,
      enabled: routeForm.enabled,
    });
  }

  function openAddRoute(channelId?: string) {
    setRouteForm({ ...EMPTY_ROUTE_FORM, channelId: channelId ?? "" });
    setRouteFormError(null);
    setIsAddRouteOpen(true);
  }

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">Select a company to manage channels.</div>;
  }

  const channels = channelsQuery.data ?? [];
  const routes = routesQuery.data ?? [];

  const channelsError = channelsQuery.error;
  const channelsErrorMessage =
    channelsError instanceof ApiError && channelsError.status === 403
      ? "You do not have permission to manage channels."
      : channelsError instanceof Error
        ? channelsError.message
        : null;

  return (
    <div className="max-w-5xl space-y-8">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Radio className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Channels</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Connect Slack workspaces and outbound webhooks so agents and routes can send messages, and define routes that fire on company events.
        </p>
      </div>

      <section className="rounded-xl border border-border">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">Configured channels</h2>
            <p className="text-sm text-muted-foreground">
              Stored bot tokens and webhook secrets are redacted after save.
            </p>
          </div>
          <Button onClick={() => setIsAddChannelOpen(true)}>
            <Plus className="h-4 w-4" />
            Add channel
          </Button>
        </div>

        {channelsErrorMessage ? (
          <div className="border-t border-border px-5 py-4 text-sm text-destructive">{channelsErrorMessage}</div>
        ) : channelsQuery.isLoading ? (
          <div className="border-t border-border px-5 py-6 text-sm text-muted-foreground">Loading channels…</div>
        ) : channels.length === 0 ? (
          <div className="border-t border-border px-5 py-8">
            <EmptyState
              icon={Radio}
              message="No channels yet. Add a Slack workspace or webhook to start sending messages from agents and routes."
              action="Add channel"
              onAction={() => setIsAddChannelOpen(true)}
            />
          </div>
        ) : (
          <div className="border-t border-border overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-5 py-3 font-medium text-muted-foreground">Name</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">Platform</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">Direction</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">Status</th>
                  <th className="px-5 py-3 text-right font-medium text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((channel) => (
                  <tr key={channel.id} className="border-b border-border last:border-b-0">
                    <td className="px-5 py-3 align-top">
                      <div className="font-medium text-foreground">{channel.name}</div>
                      <div className="text-xs text-muted-foreground">
                        Added {new Date(channel.createdAt).toLocaleString()}
                      </div>
                    </td>
                    <td className="px-5 py-3 align-top">
                      <Badge variant="outline">{platformLabel(channel.platform)}</Badge>
                    </td>
                    <td className="px-5 py-3 align-top text-muted-foreground">
                      {DIRECTION_LABELS[channel.direction] ?? channel.direction}
                    </td>
                    <td className="px-5 py-3 align-top">
                      <StatusBadge status={channel.status} />
                    </td>
                    <td className="px-5 py-3 text-right align-top">
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => testChannelMutation.mutate(channel.id)}
                          disabled={testingChannelId === channel.id}
                        >
                          {testingChannelId === channel.id ? (
                            <RefreshCw className="h-4 w-4 animate-spin" />
                          ) : (
                            <Send className="h-4 w-4" />
                          )}
                          Test
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openAddRoute(channel.id)}
                        >
                          <Plus className="h-4 w-4" />
                          Route
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            if (
                              window.confirm(
                                `Delete channel "${channel.name}"? Routes that target it will also be removed.`,
                              )
                            ) {
                              deleteChannelMutation.mutate(channel.id);
                            }
                          }}
                          disabled={deleteChannelMutation.isPending}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-border">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">Routes</h2>
            <p className="text-sm text-muted-foreground">
              Routes match company events to channels. A simple trigger pattern is enough for Phase 1.
            </p>
          </div>
          <Button
            onClick={() => openAddRoute()}
            disabled={channels.length === 0}
            title={channels.length === 0 ? "Add a channel first" : undefined}
          >
            <Plus className="h-4 w-4" />
            Add route
          </Button>
        </div>

        {routesQuery.isLoading ? (
          <div className="border-t border-border px-5 py-6 text-sm text-muted-foreground">Loading routes…</div>
        ) : routes.length === 0 ? (
          <div className="border-t border-border px-5 py-8">
            <EmptyState
              icon={Radio}
              message={
                channels.length === 0
                  ? "Add a channel first, then route events to it."
                  : "No routes yet. Add a route to send events to one of your channels."
              }
              action={channels.length === 0 ? undefined : "Add route"}
              onAction={channels.length === 0 ? undefined : () => openAddRoute()}
            />
          </div>
        ) : (
          <div className="border-t border-border overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-5 py-3 font-medium text-muted-foreground">Trigger</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">Channel</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">Template</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">Enabled</th>
                  <th className="px-5 py-3 text-right font-medium text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody>
                {routes.map((route) => {
                  const channel = channelsById.get(route.channelId);
                  return (
                    <tr key={route.id} className="border-b border-border last:border-b-0">
                      <td className="px-5 py-3 align-top">
                        <code className="rounded bg-muted/60 px-1.5 py-0.5 text-xs">{route.trigger}</code>
                      </td>
                      <td className="px-5 py-3 align-top">
                        {channel ? (
                          <div>
                            <div className="font-medium text-foreground">{channel.name}</div>
                            <div className="text-xs text-muted-foreground">
                              {platformLabel(channel.platform)}
                            </div>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">Unknown channel</span>
                        )}
                      </td>
                      <td className="px-5 py-3 align-top text-muted-foreground">
                        {route.template ? (
                          <span className="line-clamp-2 max-w-md text-xs">{route.template}</span>
                        ) : (
                          <span className="text-xs">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3 align-top">
                        <ToggleSwitch
                          checked={route.enabled}
                          onCheckedChange={(next) =>
                            toggleRouteMutation.mutate({ id: route.id, enabled: next })
                          }
                          aria-label={route.enabled ? "Disable route" : "Enable route"}
                        />
                      </td>
                      <td className="px-5 py-3 text-right align-top">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            if (window.confirm("Delete this route?")) {
                              deleteRouteMutation.mutate(route.id);
                            }
                          }}
                          disabled={deleteRouteMutation.isPending}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Dialog
        open={isAddChannelOpen}
        onOpenChange={(open) => {
          setIsAddChannelOpen(open);
          if (!open) {
            setChannelForm(EMPTY_CHANNEL_FORM);
            setChannelFormError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add channel</DialogTitle>
            <DialogDescription>
              Slack and webhook channels are supported in Phase 1.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="channel-platform">
                Platform
              </label>
              <Select
                value={channelForm.platform}
                onValueChange={(value) =>
                  setChannelForm((prev) => ({ ...prev, platform: value as ChannelPlatform }))
                }
              >
                <SelectTrigger id="channel-platform">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUPPORTED_PLATFORMS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {PLATFORM_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="channel-name">
                Name
              </label>
              <Input
                id="channel-name"
                placeholder={channelForm.platform === "slack" ? "Engineering Slack" : "Status webhook"}
                value={channelForm.name}
                onChange={(e) => setChannelForm((prev) => ({ ...prev, name: e.target.value }))}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="channel-direction">
                Direction
              </label>
              <Select
                value={channelForm.direction}
                onValueChange={(value) =>
                  setChannelForm((prev) => ({ ...prev, direction: value as ChannelDirection }))
                }
              >
                <SelectTrigger id="channel-direction">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHANNEL_DIRECTIONS.map((d) => (
                    <SelectItem key={d} value={d}>
                      {DIRECTION_LABELS[d]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {channelForm.platform === "slack" ? (
              <>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium" htmlFor="slack-bot-token">
                    Bot token
                  </label>
                  <Input
                    id="slack-bot-token"
                    type="password"
                    autoComplete="off"
                    placeholder="xoxb-…"
                    value={channelForm.slackBotToken}
                    onChange={(e) =>
                      setChannelForm((prev) => ({ ...prev, slackBotToken: e.target.value }))
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Stored encrypted. Redacted on read.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium" htmlFor="slack-channel-id">
                    Slack channel ID (optional)
                  </label>
                  <Input
                    id="slack-channel-id"
                    placeholder="C01234ABCDE"
                    value={channelForm.slackChannelId}
                    onChange={(e) =>
                      setChannelForm((prev) => ({ ...prev, slackChannelId: e.target.value }))
                    }
                  />
                </div>
              </>
            ) : null}

            {channelForm.platform === "webhook" ? (
              <>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium" htmlFor="webhook-url">
                    Webhook URL
                  </label>
                  <Input
                    id="webhook-url"
                    type="url"
                    placeholder="https://example.com/hooks/paperclip"
                    value={channelForm.webhookUrl}
                    onChange={(e) =>
                      setChannelForm((prev) => ({ ...prev, webhookUrl: e.target.value }))
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium" htmlFor="webhook-secret">
                    Signing secret (optional)
                  </label>
                  <Input
                    id="webhook-secret"
                    type="password"
                    autoComplete="off"
                    value={channelForm.webhookSigningSecret}
                    onChange={(e) =>
                      setChannelForm((prev) => ({
                        ...prev,
                        webhookSigningSecret: e.target.value,
                      }))
                    }
                  />
                </div>
              </>
            ) : null}

            {channelFormError ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {channelFormError}
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddChannelOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitChannelForm} disabled={createChannelMutation.isPending}>
              {createChannelMutation.isPending ? "Saving…" : "Add channel"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={isAddRouteOpen}
        onOpenChange={(open) => {
          setIsAddRouteOpen(open);
          if (!open) {
            setRouteForm(EMPTY_ROUTE_FORM);
            setRouteFormError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add route</DialogTitle>
            <DialogDescription>
              Match company events to a channel. Triggers are short identifiers like
              <code className="mx-1 rounded bg-muted/60 px-1.5 py-0.5 text-xs">issue.completed</code>
              for now.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="route-channel">
                Channel
              </label>
              <Select
                value={routeForm.channelId}
                onValueChange={(value) => setRouteForm((prev) => ({ ...prev, channelId: value }))}
              >
                <SelectTrigger id="route-channel">
                  <SelectValue placeholder="Pick a channel" />
                </SelectTrigger>
                <SelectContent>
                  {channels.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name} · {platformLabel(c.platform)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="route-trigger">
                Trigger
              </label>
              <Input
                id="route-trigger"
                placeholder="issue.completed"
                value={routeForm.trigger}
                onChange={(e) => setRouteForm((prev) => ({ ...prev, trigger: e.target.value }))}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="route-template">
                Template (optional)
              </label>
              <Textarea
                id="route-template"
                placeholder={"{{ issue.title }} just completed"}
                rows={3}
                value={routeForm.template}
                onChange={(e) => setRouteForm((prev) => ({ ...prev, template: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                Plain text or markdown. Templating syntax is finalized in a later phase.
              </p>
            </div>

            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <div>
                <div className="text-sm font-medium">Enabled</div>
                <div className="text-xs text-muted-foreground">
                  Disabled routes are kept on file but do not fire.
                </div>
              </div>
              <ToggleSwitch
                checked={routeForm.enabled}
                onCheckedChange={(next) => setRouteForm((prev) => ({ ...prev, enabled: next }))}
                aria-label="Toggle route enabled"
              />
            </div>

            {routeFormError ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {routeFormError}
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddRouteOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitRouteForm} disabled={createRouteMutation.isPending}>
              {createRouteMutation.isPending ? "Saving…" : "Add route"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
