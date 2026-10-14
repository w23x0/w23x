import { createModels, createProvider } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { Api, ApiKeyAuth, AuthResult, Model, ProviderStreams } from '@earendil-works/pi-ai';
import type { ModelSpec } from './config.js';

export interface ResolvedModel {
  models: any;
  model: Model<any>;
  getApiKey: (provider: string) => string | undefined;
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
}

function apiFactoryName(api: string): string {
  switch (api) {
    case 'anthropic-messages': return 'anthropicMessagesApi';
    case 'openai-responses': return 'openAIResponsesApi';
    default: return 'openAICompletionsApi';
  }
}

function modulePath(api: string): string {
  switch (api) {
    case 'anthropic-messages': return '@earendil-works/pi-ai/api/anthropic-messages.lazy';
    case 'openai-responses': return '@earendil-works/pi-ai/api/openai-responses.lazy';
    default: return '@earendil-works/pi-ai/api/openai-completions.lazy';
  }
}

export async function makeModels(spec: ModelSpec): Promise<ResolvedModel> {
  const supportsReasoning = (spec.reasoning ?? undefined);
  const thinkingLevel: ResolvedModel['thinkingLevel'] =
    spec.thinkingLevel ?? (supportsReasoning ? 'medium' : undefined);

  // custom endpoint
  if (spec.baseUrl) {
    const api = spec.api || 'openai-completions';
    const providerId = spec.provider || 'custom';
    const mod = (await import(modulePath(api))) as Record<string, () => ProviderStreams>;
    const factory = mod[apiFactoryName(api)];
    const model: Model<Api> = {
      id: spec.id,
      name: spec.id,
      api,
      provider: providerId,
      baseUrl: spec.baseUrl,
      reasoning: spec.reasoning ?? false,
      input: spec.input ?? ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: spec.contextWindow ?? 128000,
      maxTokens: spec.maxTokens ?? 32768,
      headers: spec.headers,
    };

    // pi-ai resolves keys through provider.auth.apiKey; the agent's getApiKey arrives as a credential.
    const apiKeyAuth: ApiKeyAuth = {
      name: `${providerId} API key`,
      resolve: async ({ credential }): Promise<AuthResult | undefined> => {
        const key = credential?.key ?? spec.apiKey;
        if (!key) return undefined;
        return { auth: { apiKey: key }, source: credential?.key ? 'agent' : 'config' };
      },
    };

    const provider = createProvider({
      id: providerId,
      name: providerId,
      baseUrl: spec.baseUrl,
      headers: spec.headers,
      auth: { apiKey: apiKeyAuth },
      models: [model],
      api: factory(),
    });
    const models = createModels();
    models.setProvider(provider);
    const resolved = models.getModel(providerId, spec.id)!;
    return {
      models,
      model: resolved,
      getApiKey: () => spec.apiKey,
      thinkingLevel: thinkingLevel ?? (resolved?.reasoning ? 'medium' : 'off'),
    };
  }

  // builtin catalog
  const models = builtinModels();
  if (!spec.provider) throw new Error('model.provider is required for builtin catalog models');
  const provider = spec.provider;
  const model = models.getModel(provider, spec.id);
  if (!model) throw new Error(`model not found: ${provider}/${spec.id}`);
  // derive reasoning from catalog when spec.reasoning unspecified
  const catalogReasoning = (model as any)?.reasoning === true;
  const supports = spec.reasoning ?? catalogReasoning;
  return {
    models,
    model,
    getApiKey: () => spec.apiKey,
    thinkingLevel: spec.thinkingLevel ?? (supports ? 'medium' : 'off'),
  };
}

export async function makeModelsForSpecs(primary: ModelSpec, reflection?: ModelSpec): Promise<{ primary: ResolvedModel; reflection: ResolvedModel }> {
  const p = await makeModels(primary);
  let r: ResolvedModel = p;
  if (reflection && (reflection.id !== primary.id || reflection.baseUrl !== primary.baseUrl || reflection.provider !== primary.provider)) {
    try { r = await makeModels(reflection); }
    catch (e: any) { console.warn('reflection model build failed, falling back to primary:', e?.message || e); r = p; }
  }
  return { primary: p, reflection: r };
}