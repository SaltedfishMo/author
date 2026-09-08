export function getEmbeddingProviderConfig(apiConfig = {}, providerKey = apiConfig.embedProvider, defaults = {}) {
    const saved = apiConfig.embedProviderConfigs?.[providerKey] || {};
    const active = providerKey === apiConfig.embedProvider;
    const apiKey = (active ? apiConfig.embedApiKey : undefined) ?? saved.apiKey ?? '';
    const baseUrl = (active ? apiConfig.embedBaseUrl : undefined) ?? saved.baseUrl ?? defaults.baseUrl ?? '';
    const model = (active ? apiConfig.embedModel : undefined) ?? saved.model ?? '';
    const reuseChatKey = apiConfig.embedReuseChatKey !== false;
    const effectiveApiKey = apiKey || (reuseChatKey ? apiConfig.apiKey : '') || '';
    const allowKeyless = !!apiConfig.useCustomEmbed && !reuseChatKey;
    const hasProviderConfig = active || Object.hasOwn(apiConfig.embedProviderConfigs || {}, providerKey);

    return {
        apiKey,
        baseUrl,
        model,
        effectiveApiKey,
        allowKeyless,
        isConfigured: !!apiConfig.useCustomEmbed && !!providerKey && hasProviderConfig && !!baseUrl.trim()
            && (!!effectiveApiKey.trim() || allowKeyless),
    };
}

export function switchEmbeddingModel(apiConfig = {}, providerKey, modelId, defaults = {}) {
    let configs = { ...(apiConfig.embedProviderConfigs || {}) };
    const previous = apiConfig.embedProvider;
    if (previous) {
        const saved = configs[previous] || {};
        configs = {
            ...configs,
            [previous]: {
                ...saved,
                apiKey: apiConfig.embedApiKey ?? saved.apiKey ?? '',
                baseUrl: apiConfig.embedBaseUrl ?? saved.baseUrl ?? '',
                model: apiConfig.embedModel ?? saved.model ?? '',
            },
        };
    }
    const selected = getEmbeddingProviderConfig({ ...apiConfig, embedProviderConfigs: configs }, providerKey, defaults);
    return {
        ...apiConfig,
        embedProvider: providerKey,
        embedModel: modelId,
        embedApiKey: selected.apiKey,
        embedBaseUrl: selected.baseUrl,
        embedProviderConfigs: {
            ...configs,
            [providerKey]: {
                ...(configs[providerKey] || {}),
                apiKey: selected.apiKey,
                baseUrl: selected.baseUrl,
                model: modelId,
            },
        },
    };
}
