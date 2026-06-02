import type {
  Channel,
  ChannelMessage,
  ChannelMessageStatus,
  ChannelRoute,
  CreateChannel,
  CreateChannelRoute,
  UpdateChannel,
  UpdateChannelRoute,
} from "@paperclipai/shared";
import { api } from "./client";

export interface TestChannelResult {
  delivered: boolean;
  status: ChannelMessageStatus;
  attempts: number;
  message: ChannelMessage;
  error?: string;
}

export const channelsApi = {
  list: (companyId: string) => api.get<Channel[]>(`/companies/${companyId}/channels`),
  create: (companyId: string, data: CreateChannel) =>
    api.post<Channel>(`/companies/${companyId}/channels`, data),
  get: (id: string) => api.get<Channel>(`/channels/${id}`),
  update: (id: string, data: UpdateChannel) => api.patch<Channel>(`/channels/${id}`, data),
  remove: (id: string) => api.delete<void>(`/channels/${id}`),
  test: (id: string, content?: string) =>
    api.post<TestChannelResult>(`/channels/${id}/test`, content ? { content } : {}),
};

export const channelRoutesApi = {
  list: (companyId: string, channelId?: string) => {
    const qs = channelId ? `?channelId=${encodeURIComponent(channelId)}` : "";
    return api.get<ChannelRoute[]>(`/companies/${companyId}/routes${qs}`);
  },
  create: (companyId: string, data: CreateChannelRoute) =>
    api.post<ChannelRoute>(`/companies/${companyId}/routes`, data),
  update: (id: string, data: UpdateChannelRoute) =>
    api.patch<ChannelRoute>(`/routes/${id}`, data),
  remove: (id: string) => api.delete<void>(`/routes/${id}`),
};
