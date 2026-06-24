export function cleanJsonSchema(schema) {
    if (!schema || typeof schema !== 'object') {
        return schema;
    }

    const needsCleanup = Object.keys(schema).some((key) => key === '$schema');

    if (!needsCleanup) {
        let hasChanges = false;
        const result = {...schema};

        for (const key in result) {
            if (key === 'properties' && typeof result[key] === 'object') {
                const cleaned = cleanJsonSchema(result[key]);
                if (cleaned !== result[key]) {
                    result[key] = cleaned;
                    hasChanges = true;
                }
            } else if (key === 'items' && typeof result[key] === 'object') {
                const cleaned = cleanJsonSchema(result[key]);
                if (cleaned !== result[key]) {
                    result[key] = cleaned;
                    hasChanges = true;
                }
            } else if (typeof result[key] === 'object' && !Array.isArray(result[key])) {
                const cleaned = cleanJsonSchema(result[key]);
                if (cleaned !== result[key]) {
                    result[key] = cleaned;
                    hasChanges = true;
                }
            }
        }

        return hasChanges ? result : schema;
    }

    const cleaned = {};
    for (const key in schema) {
        if (key === '$schema') {
            continue;
        }

        if (key === 'enum' && Array.isArray(schema[key])) {
            cleaned[key] = schema[key];
        } else if (key === 'properties' && typeof schema[key] === 'object') {
            cleaned[key] = cleanJsonSchema(schema[key]);
        } else if (key === 'items' && typeof schema[key] === 'object') {
            cleaned[key] = cleanJsonSchema(schema[key]);
        } else if (typeof schema[key] === 'object' && !Array.isArray(schema[key])) {
            cleaned[key] = cleanJsonSchema(schema[key]);
        } else {
            cleaned[key] = schema[key];
        }
    }

    return cleaned;
}
