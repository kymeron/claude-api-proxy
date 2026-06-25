export function mapCodebuddyModelName(model) {
    if (!model || typeof model !== 'string') return model;
    const lower = model.toLowerCase();

    if (lower.startsWith('gpt-') || lower.includes('mini')) {
        return 'deepseek-v4-flash';
    }
    return model;
}
